import { test } from "node:test";
import assert from "node:assert/strict";

import { ANSWER_STATUSES, ANSWER_TOOL, fallbackAnswer, isWellFormedAnswer } from "../lib/answerContract.js";

function validAnswer(overrides = {}) {
  return {
    answer: "The device has a 200kg safe working load.",
    status: "confirmed",
    sources: ["hovermatt-usage-and-ifu.md"],
    customer_ready: "The device has a 200kg safe working load.",
    related_documents: [],
    ...overrides
  };
}

test("fallbackAnswer produces a well-formed, cannot_answer-status object", () => {
  const fallback = fallbackAnswer("API timed out");
  assert.equal(isWellFormedAnswer(fallback), true);
  assert.equal(fallback.status, "cannot_answer");
  assert.match(fallback.answer, /API timed out/);
});

test("isWellFormedAnswer accepts a fully valid candidate", () => {
  assert.equal(isWellFormedAnswer(validAnswer()), true);
});

test("isWellFormedAnswer rejects a non-object", () => {
  assert.equal(isWellFormedAnswer(null), false);
  assert.equal(isWellFormedAnswer("a string"), false);
  assert.equal(isWellFormedAnswer(undefined), false);
});

test("isWellFormedAnswer rejects a missing/non-string answer", () => {
  assert.equal(isWellFormedAnswer(validAnswer({ answer: undefined })), false);
  assert.equal(isWellFormedAnswer(validAnswer({ answer: 5 })), false);
});

test("isWellFormedAnswer rejects a status outside the enum (cannot silently invent a status)", () => {
  assert.equal(isWellFormedAnswer(validAnswer({ status: "probably_true" })), false);
  for (const status of ANSWER_STATUSES) {
    assert.equal(isWellFormedAnswer(validAnswer({ status })), true);
  }
});

test("isWellFormedAnswer rejects non-array or non-string-array sources", () => {
  assert.equal(isWellFormedAnswer(validAnswer({ sources: "hovermatt.md" })), false);
  assert.equal(isWellFormedAnswer(validAnswer({ sources: [1, 2] })), false);
});

test("isWellFormedAnswer rejects a non-string customer_ready", () => {
  assert.equal(isWellFormedAnswer(validAnswer({ customer_ready: null })), false);
});

test("isWellFormedAnswer rejects non-array or non-string-array related_documents", () => {
  assert.equal(isWellFormedAnswer(validAnswer({ related_documents: "a.md" })), false);
  assert.equal(isWellFormedAnswer(validAnswer({ related_documents: [{ a: 1 }] })), false);
});

test("the provide_answer tool schema requires every field of the answer contract", () => {
  const required = ANSWER_TOOL.input_schema.required;
  for (const field of ["answer", "status", "sources", "customer_ready", "related_documents"]) {
    assert.ok(required.includes(field), `expected ${field} to be required`);
  }
});

test("the provide_answer tool schema's status enum matches ANSWER_STATUSES exactly, including needs_confirmation", () => {
  const schemaEnum = ANSWER_TOOL.input_schema.properties.status.enum;
  assert.deepEqual(new Set(schemaEnum), new Set(ANSWER_STATUSES));
  assert.ok(schemaEnum.includes("needs_confirmation"));
});
