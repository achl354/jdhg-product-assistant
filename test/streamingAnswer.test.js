import { test } from "node:test";
import assert from "node:assert/strict";

import { extractPartialAnswerText } from "../lib/streamingAnswer.js";

test("returns null when the answer key hasn't started arriving yet", () => {
  assert.equal(extractPartialAnswerText(""), null);
  assert.equal(extractPartialAnswerText('{"stat'), null);
  assert.equal(extractPartialAnswerText('{"answer'), null); // key present but no colon/quote yet
});

test("returns the partial (still-open) string content before the closing quote arrives", () => {
  assert.equal(extractPartialAnswerText('{"answer":"Hello wor'), "Hello wor");
});

test("returns the complete decoded string once the closing quote arrives", () => {
  assert.equal(extractPartialAnswerText('{"answer":"Hello world","status":"confirmed"'), "Hello world");
});

test("decodes standard JSON escape sequences", () => {
  const buf = String.raw`{"answer":"line one\nline two\ttabbed \"quoted\" back\\slash forward\/slash`;
  assert.equal(extractPartialAnswerText(buf), 'line one\nline two\ttabbed "quoted" back\\slash forward/slash');
});

test("decodes a unicode escape once all 4 hex digits have arrived", () => {
  assert.equal(extractPartialAnswerText('{"answer":"caf\\u00e9'), "café");
});

test("stops gracefully (without throwing) on a dangling backslash at the buffer end", () => {
  assert.equal(extractPartialAnswerText('{"answer":"almost done\\'), "almost done");
});

test("stops gracefully on an incomplete unicode escape at the buffer end", () => {
  assert.equal(extractPartialAnswerText('{"answer":"caf\\u00'), "caf");
});

test("grows correctly as more raw text is appended across repeated calls, simulating real streaming", () => {
  const fullJson = JSON.stringify({ answer: "The quick brown fox jumps.", status: "confirmed" });
  const seen = [];
  let buffer = "";
  for (const chunk of fullJson.match(/.{1,5}/g)) {
    buffer += chunk;
    const extracted = extractPartialAnswerText(buffer);
    if (typeof extracted === "string") seen.push(extracted);
  }
  // Should have grown incrementally, not jumped straight to the final value.
  assert.ok(seen.length > 3, `expected multiple incremental extractions, got ${seen.length}`);
  assert.equal(seen.at(-1), "The quick brown fox jumps.");
  // Every subsequent extraction should be a superset (monotonically growing prefix).
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].startsWith(seen[i - 1]) || seen[i] === seen[i - 1], `expected ${JSON.stringify(seen[i])} to extend ${JSON.stringify(seen[i - 1])}`);
  }
});

test("finds the answer key even when it isn't the first key in the buffer", () => {
  assert.equal(extractPartialAnswerText('{"status":"confirmed","answer":"here it is'), "here it is");
});
