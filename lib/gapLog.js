// gapLog.js
//
// Append-only log of questions the bot had no knowledge-base coverage for
// (a real, well-formed model response with status "cannot_answer" — never
// technical failures like a missing API key or a parse failure, which are
// server problems, not knowledge gaps). Lets a human review what's missing
// and add knowledge later, via GET /admin/gaps.
//
// Caveat worth knowing: on a host with an ephemeral filesystem (e.g. a
// Render free-tier redeploy), this file is wiped whenever a new deploy
// creates a fresh filesystem. Fine for a pilot; revisit if gap history
// needs to survive redeploys long-term.
import fs from "fs";
import path from "path";

export function appendGap(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

export function readGaps(logPath) {
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

// Renders a small, self-contained admin page (no client JS needed) listing
// flagged gaps newest-first. Reached at GET /admin/gaps, behind whatever
// basic-auth middleware server.js already applies to every route.
export function renderGapsPage(gaps) {
  const sorted = [...gaps].reverse();
  const rows = sorted
    .map(
      (g) => `
        <div class="gap">
          <div class="gap-time">${escapeHtml(g.timestamp)}</div>
          <div class="gap-question">${escapeHtml(g.question)}</div>
          <div class="gap-answer">${escapeHtml(g.answer)}</div>
        </div>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Knowledge gaps — JDHG Product Assistant</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: #F1F4F9; margin: 0; padding: 24px; color: #1F2937; }
  h1 { font-size: 18px; color: #1B3F73; margin: 0 0 4px; }
  .count { color: #6B7280; font-size: 13px; margin-bottom: 20px; }
  .gap { background: #fff; border: 1px solid #E2E5EA; border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; max-width: 720px; }
  .gap-time { font-size: 11px; color: #6B7280; margin-bottom: 4px; }
  .gap-question { font-weight: 600; margin-bottom: 4px; }
  .gap-answer { font-size: 13px; color: #4B5563; white-space: pre-wrap; }
  .empty { color: #6B7280; }
</style>
</head>
<body>
  <h1>Flagged knowledge gaps</h1>
  <div class="count">${gaps.length} question${gaps.length === 1 ? "" : "s"} with no knowledge-base coverage${gaps.length ? ", newest first" : ""}</div>
  ${gaps.length ? rows : '<div class="empty">No flagged questions yet.</div>'}
</body>
</html>`;
}
