// feedbackLog.js
//
// Append-only log of per-answer thumbs up/down feedback from reps, plus the
// request validation for POST /api/feedback and a small admin review page
// at GET /admin/feedback. Mirrors lib/gapLog.js's shape deliberately — same
// append-only-JSONL-plus-HTML-page pattern, kept as a separate small module
// rather than a shared abstraction since the two logs record different
// things and may diverge later.
import fs from "fs";
import path from "path";

export const MAX_FEEDBACK_TEXT_LENGTH = 4000;
const VALID_RATINGS = new Set(["up", "down"]);

export function validateFeedbackRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const { question, answer, rating } = body;
  if (typeof question !== "string" || question.length === 0) {
    return "question is required and must be a non-empty string.";
  }
  if (question.length > MAX_FEEDBACK_TEXT_LENGTH) {
    return `question exceeds the ${MAX_FEEDBACK_TEXT_LENGTH}-character limit.`;
  }
  if (typeof answer !== "string") {
    return "answer is required and must be a string.";
  }
  if (answer.length > MAX_FEEDBACK_TEXT_LENGTH) {
    return `answer exceeds the ${MAX_FEEDBACK_TEXT_LENGTH}-character limit.`;
  }
  if (!VALID_RATINGS.has(rating)) {
    return 'rating must be "up" or "down".';
  }
  return null;
}

export function appendFeedback(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

export function readFeedback(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderFeedbackPage(entries) {
  const sorted = [...entries].reverse();
  const upCount = entries.filter((e) => e.rating === "up").length;
  const downCount = entries.filter((e) => e.rating === "down").length;

  const rows = sorted
    .map(
      (e) => `
        <div class="entry ${e.rating === "down" ? "down" : "up"}">
          <div class="entry-head">
            <span class="rating">${e.rating === "down" ? "\u{1F44E} Not helpful" : "\u{1F44D} Helpful"}</span>
            <span class="entry-time">${escapeHtml(e.timestamp)}</span>
          </div>
          <div class="entry-question">${escapeHtml(e.question)}</div>
          <div class="entry-answer">${escapeHtml(e.answer)}</div>
        </div>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Feedback — JDHG Product Assistant</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: #F1F4F9; margin: 0; padding: 24px; color: #1F2937; }
  h1 { font-size: 18px; color: #1B3F73; margin: 0 0 4px; }
  .count { color: #6B7280; font-size: 13px; margin-bottom: 20px; }
  .entry { background: #fff; border: 1px solid #E2E5EA; border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; max-width: 720px; border-left: 3px solid #D1D5DB; }
  .entry.down { border-left-color: #DC2626; }
  .entry.up { border-left-color: #16A34A; }
  .entry-head { display: flex; justify-content: space-between; font-size: 11px; color: #6B7280; margin-bottom: 6px; }
  .rating { font-weight: 600; }
  .entry-question { font-weight: 600; margin-bottom: 4px; }
  .entry-answer { font-size: 13px; color: #4B5563; white-space: pre-wrap; }
  .empty { color: #6B7280; }
</style>
</head>
<body>
  <h1>Rep feedback</h1>
  <div class="count">${entries.length} total &middot; ${upCount} helpful &middot; ${downCount} not helpful${entries.length ? ", newest first" : ""}</div>
  ${entries.length ? rows : '<div class="empty">No feedback recorded yet.</div>'}
</body>
</html>`;
}
