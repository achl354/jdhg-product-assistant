import { test } from "node:test";
import assert from "node:assert/strict";

import { runChatStream } from "../lib/chatStream.js";
import { ANSWER_TOOL_NAME } from "../lib/answerContract.js";

// Minimal stand-in for the Anthropic SDK's MessageStream — just enough of
// its shape (on("inputJson", cb), async finalMessage()) for runChatStream to
// drive, without needing a real API key or network access. `deltas` is an
// array of RAW incremental JSON text fragments (matching event.delta.
// partial_json in the real SDK) — runChatStream accumulates these itself,
// it does not receive a pre-parsed snapshot.
function fakeStream({ deltas = [], finalContent, rejectWith }) {
  let inputJsonCb = null;
  return {
    on(event, cb) {
      if (event === "inputJson") inputJsonCb = cb;
      return this;
    },
    async finalMessage() {
      for (const rawChunk of deltas) {
        inputJsonCb(rawChunk);
      }
      if (rejectWith) throw rejectWith;
      return { content: finalContent };
    }
  };
}

function validToolUseContent(input) {
  return [{ type: "tool_use", name: ANSWER_TOOL_NAME, input }];
}

test("emits a growing answer_delta frame per raw chunk, then a final frame with the validated answer", async () => {
  const frames = [];
  const finalInput = {
    answer: "The HoverMatt has a 200kg SWL.",
    status: "confirmed",
    sources: ["hovermatt-usage-and-ifu.md"],
    customer_ready: "The HoverMatt has a 200kg safe working load.",
    related_documents: []
  };
  const stream = fakeStream({
    deltas: [
      '{"answer":"The',
      " HoverMatt",
      ' has a 200kg SWL.","status":"confirmed"'
    ],
    finalContent: validToolUseContent(finalInput)
  });

  const result = await runChatStream(stream, (frame) => frames.push(frame));

  assert.deepEqual(
    frames.filter((f) => f.type === "answer_delta").map((f) => f.text),
    ["The", "The HoverMatt", "The HoverMatt has a 200kg SWL."]
  );
  assert.equal(frames.at(-1).type, "final");
  assert.deepEqual(frames.at(-1).data, finalInput);
  assert.deepEqual(result, { data: finalInput, isGenuineCannotAnswer: false });
});

test("reveals the answer text incrementally even mid-string, character by character across many small chunks", async () => {
  const frames = [];
  const fullJson = JSON.stringify({
    answer: "Step one. Step two. Step three.",
    status: "confirmed",
    sources: [],
    customer_ready: "",
    related_documents: []
  });
  // Split into small, arbitrary-boundary chunks — not aligned to string
  // content — the way a real token stream would actually arrive.
  const rawChunks = fullJson.match(/.{1,4}/g);
  const stream = fakeStream({ deltas: rawChunks, finalContent: validToolUseContent(JSON.parse(fullJson)) });

  await runChatStream(stream, (frame) => frames.push(frame));

  const deltaTexts = frames.filter((f) => f.type === "answer_delta").map((f) => f.text);
  // The key behavior this guards against regressing: the answer must reveal
  // progressively (many distinct growing values), not jump straight from
  // nothing to the complete string in one frame.
  assert.ok(deltaTexts.length > 3, `expected incremental reveal, got ${deltaTexts.length} delta frame(s)`);
  assert.equal(deltaTexts.at(-1), "Step one. Step two. Step three.");
  for (let i = 1; i < deltaTexts.length; i++) {
    assert.ok(deltaTexts[i].startsWith(deltaTexts[i - 1]));
  }
});

test("does not re-emit a delta frame when the extracted answer text hasn't changed", async () => {
  const frames = [];
  const finalInput = {
    answer: "Same text",
    status: "confirmed",
    sources: [],
    customer_ready: "Same text",
    related_documents: []
  };
  const stream = fakeStream({
    deltas: [
      '{"answer":"Same text',
      "", // an empty/no-op raw chunk shouldn't cause a duplicate frame
      '","status":"confirmed"'
    ],
    finalContent: validToolUseContent(finalInput)
  });

  await runChatStream(stream, (frame) => frames.push(frame));

  const deltaFrames = frames.filter((f) => f.type === "answer_delta");
  // "Same text" (open), then "Same text" again once closed — the closing
  // event doesn't change the extracted text, so it must not duplicate.
  assert.equal(deltaFrames.length, 1);
});

test("a genuine well-formed cannot_answer is reported as isGenuineCannotAnswer", async () => {
  const finalInput = {
    answer: "I don't have that in my current knowledge base.",
    status: "cannot_answer",
    sources: [],
    customer_ready: "",
    related_documents: []
  };
  const stream = fakeStream({ finalContent: validToolUseContent(finalInput) });

  const result = await runChatStream(stream, () => {});

  assert.equal(result.isGenuineCannotAnswer, true);
  assert.deepEqual(result.data, finalInput);
});

test("a thrown error while streaming resolves to fallbackAnswer, not a genuine cannot_answer", async () => {
  const frames = [];
  const stream = fakeStream({ rejectWith: new Error("network blip") });

  const result = await runChatStream(stream, (frame) => frames.push(frame));

  assert.equal(result.isGenuineCannotAnswer, false);
  assert.equal(result.data.status, "cannot_answer");
  assert.match(result.data.answer, /failed to reach the assistant/);
  assert.equal(frames.at(-1).type, "final");
  assert.deepEqual(frames.at(-1).data, result.data);
});

test("a missing tool_use block resolves to fallbackAnswer, not a genuine cannot_answer", async () => {
  const stream = fakeStream({ finalContent: [{ type: "text", text: "oops, no tool call" }] });

  const result = await runChatStream(stream, () => {});

  assert.equal(result.isGenuineCannotAnswer, false);
  assert.equal(result.data.status, "cannot_answer");
  assert.match(result.data.answer, /could not be parsed/);
});

test("a malformed tool_use input (fails isWellFormedAnswer) resolves to fallbackAnswer, not a genuine cannot_answer", async () => {
  const stream = fakeStream({
    finalContent: validToolUseContent({ answer: "incomplete shape", status: "confirmed" })
  });

  const result = await runChatStream(stream, () => {});

  assert.equal(result.isGenuineCannotAnswer, false);
  assert.equal(result.data.status, "cannot_answer");
});
