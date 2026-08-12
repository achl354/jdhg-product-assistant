// chatStream.js
//
// Orchestrates one /api/chat streaming turn against an Anthropic
// MessageStream-shaped object — decoupled from Express and the live SDK so
// the frame sequence and fallback behavior are unit-testable with a fake
// stream (see test/chatStream.test.js) rather than requiring a real API key.
//
// `stream` just needs to look like the SDK's MessageStream: an `on(event,
// cb)` method (only "inputJson" is used) and an async `finalMessage()`.
//
// The "inputJson" event's own best-effort parsed snapshot (its second
// callback argument) is NOT used for the delta text — the SDK's vendored
// partial-JSON parser discards a string value entirely until its closing
// quote arrives, so it can only reveal the "answer" field once complete,
// not character-by-character. Instead this accumulates the event's raw
// incremental JSON text (its first argument) itself and runs
// extractPartialAnswerText over the growing buffer, which does return
// partial (still-open) string content — see lib/streamingAnswer.js.
import { ANSWER_TOOL_NAME, fallbackAnswer, isWellFormedAnswer } from "./answerContract.js";
import { extractPartialAnswerText } from "./streamingAnswer.js";

// Runs the stream to completion, calling writeFrame(frame) for each
// "answer_delta" (text so far, only when it actually changed) and exactly
// once for the terminal "final" frame (always a well-formed answer-contract
// object — a real model answer, or fallbackAnswer(...) on any failure).
//
// options.attachDocumentLinks, if provided, is called as
// attachDocumentLinks(data) right before the final frame is written, and its
// return value replaces data — this is how server.js attaches real,
// verified document links (see lib/documentLinks.js) without this module
// needing to know anything about sources.meta.json or the filesystem.
// Omitting it (as the existing unit tests do) leaves data exactly as the
// model/fallback produced it.
//
// Returns { data, isGenuineCannotAnswer } — isGenuineCannotAnswer is true
// only when the model itself produced a well-formed status "cannot_answer"
// (real missing knowledge), never when "cannot_answer" came from a
// technical-failure fallbackAnswer(). Callers use this to decide whether to
// log a knowledge gap, without conflating the two very different meanings
// "cannot_answer" can have in the response shape.
export async function runChatStream(stream, writeFrame, options = {}) {
  let rawBuffer = "";
  let lastSentAnswer = "";
  stream.on("inputJson", (partialJson) => {
    rawBuffer += partialJson;
    const extracted = extractPartialAnswerText(rawBuffer);
    if (typeof extracted === "string" && extracted !== lastSentAnswer) {
      lastSentAnswer = extracted;
      writeFrame({ type: "answer_delta", text: extracted });
    }
  });

  let data;
  let isGenuineCannotAnswer = false;

  try {
    const finalMessage = await stream.finalMessage();
    const toolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === ANSWER_TOOL_NAME);
    if (!toolUse || !isWellFormedAnswer(toolUse.input)) {
      console.error("Model response did not contain a well-formed provide_answer call.");
      data = fallbackAnswer("the assistant's response could not be parsed");
    } else {
      data = toolUse.input;
      isGenuineCannotAnswer = data.status === "cannot_answer";
    }
  } catch (err) {
    console.error("Chat request failed:", err.message);
    data = fallbackAnswer("failed to reach the assistant");
  }

  if (typeof options.attachDocumentLinks === "function") {
    data = options.attachDocumentLinks(data);
  }

  writeFrame({ type: "final", data });
  return { data, isGenuineCannotAnswer };
}
