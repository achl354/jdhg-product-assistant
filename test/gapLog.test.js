import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import { appendGap, readGaps, renderGapsPage } from "../lib/gapLog.js";

function tempLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gaplog-test-"));
  return path.join(dir, "nested", "knowledge-gaps.jsonl");
}

test("readGaps returns an empty array when the log file doesn't exist yet", () => {
  const logPath = tempLogPath();
  assert.deepEqual(readGaps(logPath), []);
});

test("appendGap creates the parent directory and file on first write", () => {
  const logPath = tempLogPath();
  assert.equal(fs.existsSync(logPath), false);
  appendGap(logPath, { timestamp: "2026-07-29T00:00:00.000Z", question: "q1", answer: "a1" });
  assert.equal(fs.existsSync(logPath), true);
});

test("appendGap + readGaps round-trips a single entry", () => {
  const logPath = tempLogPath();
  const entry = { timestamp: "2026-07-29T00:00:00.000Z", question: "What is the warranty on a toaster?", answer: "Not covered." };
  appendGap(logPath, entry);
  assert.deepEqual(readGaps(logPath), [entry]);
});

test("multiple appends accumulate in order and each stays on its own line", () => {
  const logPath = tempLogPath();
  appendGap(logPath, { timestamp: "t1", question: "q1", answer: "a1" });
  appendGap(logPath, { timestamp: "t2", question: "q2", answer: "a2" });
  appendGap(logPath, { timestamp: "t3", question: "q3", answer: "a3" });

  const gaps = readGaps(logPath);
  assert.equal(gaps.length, 3);
  assert.deepEqual(gaps.map((g) => g.question), ["q1", "q2", "q3"]);

  const rawLines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
  assert.equal(rawLines.length, 3);
});

test("readGaps skips blank trailing lines without throwing", () => {
  const logPath = tempLogPath();
  appendGap(logPath, { timestamp: "t1", question: "q1", answer: "a1" });
  fs.appendFileSync(logPath, "\n\n");
  assert.equal(readGaps(logPath).length, 1);
});

test("renderGapsPage shows an empty-state message when there are no gaps", () => {
  const html = renderGapsPage([]);
  assert.match(html, /No flagged questions yet\./);
  assert.match(html, /0 questions/);
});

test("renderGapsPage lists gaps newest-first", () => {
  const html = renderGapsPage([
    { timestamp: "t1", question: "first question", answer: "a1" },
    { timestamp: "t2", question: "second question", answer: "a2" }
  ]);
  const firstIndex = html.indexOf("first question");
  const secondIndex = html.indexOf("second question");
  assert.ok(secondIndex < firstIndex, "expected the most recently appended gap to appear first");
});

test("renderGapsPage escapes HTML in the question/answer so a malicious question can't inject markup", () => {
  const html = renderGapsPage([
    { timestamp: "t1", question: '<script>alert("xss")</script>', answer: "n/a" }
  ]);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderGapsPage reports the correct singular/plural count", () => {
  const singular = renderGapsPage([{ timestamp: "t1", question: "q", answer: "a" }]);
  assert.match(singular, /1 question /);
  const plural = renderGapsPage([
    { timestamp: "t1", question: "q1", answer: "a1" },
    { timestamp: "t2", question: "q2", answer: "a2" }
  ]);
  assert.match(plural, /2 questions/);
});
