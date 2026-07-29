import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import {
  validateFeedbackRequest,
  appendFeedback,
  readFeedback,
  renderFeedbackPage,
  MAX_FEEDBACK_TEXT_LENGTH
} from "../lib/feedbackLog.js";

function tempLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedbacklog-test-"));
  return path.join(dir, "nested", "feedback.jsonl");
}

test("validateFeedbackRequest accepts a well-formed body", () => {
  assert.equal(validateFeedbackRequest({ question: "q", answer: "a", rating: "up" }), null);
  assert.equal(validateFeedbackRequest({ question: "q", answer: "a", rating: "down" }), null);
});

test("validateFeedbackRequest rejects a non-object body", () => {
  assert.match(validateFeedbackRequest(null), /JSON object/);
  assert.match(validateFeedbackRequest("x"), /JSON object/);
  assert.match(validateFeedbackRequest([]), /JSON object/);
});

test("validateFeedbackRequest rejects a missing/empty question", () => {
  assert.match(validateFeedbackRequest({ answer: "a", rating: "up" }), /question is required/);
  assert.match(validateFeedbackRequest({ question: "", answer: "a", rating: "up" }), /question is required/);
});

test("validateFeedbackRequest rejects an oversized question or answer", () => {
  const long = "a".repeat(MAX_FEEDBACK_TEXT_LENGTH + 1);
  assert.match(validateFeedbackRequest({ question: long, answer: "a", rating: "up" }), /question exceeds/);
  assert.match(validateFeedbackRequest({ question: "q", answer: long, rating: "up" }), /answer exceeds/);
});

test("validateFeedbackRequest rejects a non-string answer", () => {
  assert.match(validateFeedbackRequest({ question: "q", answer: 5, rating: "up" }), /answer is required/);
});

test("validateFeedbackRequest rejects a rating outside up/down", () => {
  assert.match(validateFeedbackRequest({ question: "q", answer: "a", rating: "meh" }), /rating must be/);
  assert.match(validateFeedbackRequest({ question: "q", answer: "a" }), /rating must be/);
});

test("readFeedback returns an empty array when the log file doesn't exist yet", () => {
  assert.deepEqual(readFeedback(tempLogPath()), []);
});

test("appendFeedback + readFeedback round-trips entries in order", () => {
  const logPath = tempLogPath();
  appendFeedback(logPath, { timestamp: "t1", question: "q1", answer: "a1", rating: "up" });
  appendFeedback(logPath, { timestamp: "t2", question: "q2", answer: "a2", rating: "down" });

  const entries = readFeedback(logPath);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.rating), ["up", "down"]);
});

test("renderFeedbackPage shows an empty-state message when there is no feedback", () => {
  const html = renderFeedbackPage([]);
  assert.match(html, /No feedback recorded yet\./);
  assert.match(html, /0 total/);
});

test("renderFeedbackPage counts helpful vs not-helpful correctly and lists newest-first", () => {
  const html = renderFeedbackPage([
    { timestamp: "t1", question: "alpha question", answer: "a1", rating: "up" },
    { timestamp: "t2", question: "bravo question", answer: "a2", rating: "down" },
    { timestamp: "t3", question: "charlie question", answer: "a3", rating: "up" }
  ]);
  assert.match(html, /3 total/);
  assert.match(html, /2 helpful/);
  assert.match(html, /1 not helpful/);
  const alphaIndex = html.indexOf("alpha question");
  const charlieIndex = html.indexOf("charlie question");
  assert.ok(charlieIndex < alphaIndex, "expected the most recently appended entry to appear first");
});

test("renderFeedbackPage escapes HTML in question/answer", () => {
  const html = renderFeedbackPage([
    { timestamp: "t1", question: '<img src=x onerror=alert(1)>', answer: "n/a", rating: "down" }
  ]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});
