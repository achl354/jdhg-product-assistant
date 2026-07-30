// server.js
//
// Pilot JD Healthcare Group Product Q&A bot for JDHG reps.
//
// Deliberately simple: no live SharePoint search, no Teams/Bot Framework
// dependency. The entire knowledge base is a small set of manually curated
// markdown files (knowledge/*.md, knowledge/marketing/*.md) exported once
// from vetted current documents. This sidesteps the Azure AD app
// registration + admin consent that live SharePoint access would require,
// at the cost of needing a manual re-export when a source document changes
// (see MARKETING_RESYNC.md).
//
// Cost control: rather than sending every knowledge file on every request,
// a keyword router picks only the files relevant to the question (plus the
// last couple of turns, so follow-ups keep context). This is plain string
// matching, not embeddings/RAG — appropriate for a knowledge base this size.
// A question that matches nothing falls back to the full set rather than
// risking a false "not in my knowledge base."
//
// Business logic lives in lib/ so it can be unit-tested without starting
// this express app or calling the live Anthropic API — see test/.
import path from "path";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";

import {
  ALWAYS_INCLUDE,
  KNOWLEDGE_INDEX,
  loadAllKnowledgeFiles,
  findMissingKnowledgeFiles,
  buildSearchText,
  selectRelevantFiles,
  buildKnowledgeBlock
} from "./lib/knowledgeStore.js";
import { assertAuthConfigured, createBasicAuthMiddleware } from "./lib/auth.js";
import { validateChatRequest, MAX_REQUEST_BODY_SIZE } from "./lib/requestValidation.js";
import { ANSWER_TOOL, ANSWER_TOOL_NAME, fallbackAnswer } from "./lib/answerContract.js";
import { STATIC_INSTRUCTIONS } from "./lib/prompt.js";
import { appendGap, readGaps, renderGapsPage } from "./lib/gapLog.js";
import { runChatStream } from "./lib/chatStream.js";
import { validateFeedbackRequest, appendFeedback, readFeedback, renderFeedbackPage } from "./lib/feedbackLog.js";
import { isEmailAlertConfigured, buildDownvoteAlertEmail } from "./lib/emailAlert.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const PORT = process.env.PORT || 3000;
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const GAPS_LOG_PATH = path.join(process.cwd(), "data", "knowledge-gaps.jsonl");
const FEEDBACK_LOG_PATH = path.join(process.cwd(), "data", "feedback.jsonl");
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "true";

// --- Startup checks: fail loudly and immediately rather than serving a
// misconfigured instance. Both of these are cheap, deterministic checks —
// there's no good reason to defer either failure to the first request.

const authCheck = assertAuthConfigured({
  user: BASIC_AUTH_USER,
  pass: BASIC_AUTH_PASS,
  isProduction: IS_PRODUCTION,
  allowUnauthenticated: ALLOW_UNAUTHENTICATED
});
if (!authCheck.ok) {
  console.error(`FATAL: ${authCheck.message}`);
  process.exit(1);
}
if (authCheck.warning) {
  console.warn(`WARNING: ${authCheck.warning}`);
}

const KNOWLEDGE_FILES = loadAllKnowledgeFiles(KNOWLEDGE_DIR);
const ALL_FILENAMES = [...KNOWLEDGE_FILES.keys()];

const missingKnowledgeFiles = findMissingKnowledgeFiles(KNOWLEDGE_FILES, KNOWLEDGE_INDEX, ALWAYS_INCLUDE);
if (missingKnowledgeFiles.length > 0) {
  console.error(
    "FATAL: KNOWLEDGE_INDEX (or ALWAYS_INCLUDE) references knowledge file(s) that don't exist on disk:\n" +
      missingKnowledgeFiles.map((f) => `  - ${f}`).join("\n")
  );
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const basicAuth = createBasicAuthMiddleware({ user: BASIC_AUTH_USER, pass: BASIC_AUTH_PASS });

// Downvote email alerts are entirely optional — only active when a full set
// of SMTP env vars is present. Otherwise the feedback flow is unaffected,
// just without the alert (mirrors how ANTHROPIC_API_KEY/BASIC_AUTH degrade).
const emailAlertsEnabled = isEmailAlertConfigured(process.env);
let mailTransporter = null;
if (emailAlertsEnabled) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
} else {
  console.warn(
    "WARNING: downvote email alerts are disabled — set SMTP_HOST, SMTP_USER, SMTP_PASS, and ALERT_EMAIL_TO to enable them."
  );
}

const app = express();
app.use(basicAuth);
app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));
app.use(express.static(path.join(process.cwd(), "public")));

app.post("/api/chat", async (req, res) => {
  const validationError = validateChatRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { message, history = [] } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json(fallbackAnswer("ANTHROPIC_API_KEY is not configured on the server."));
  }

  const searchText = buildSearchText(message, history);
  const selectedFiles = selectRelevantFiles(searchText, KNOWLEDGE_FILES, KNOWLEDGE_INDEX, ALWAYS_INCLUDE);
  const knowledgeBlock = buildKnowledgeBlock(selectedFiles, KNOWLEDGE_FILES);

  console.log(`[chat] routed to: ${selectedFiles.join(", ")}`);

  // Streamed as newline-delimited JSON frames rather than one JSON response,
  // so the browser can reveal the answer as it's generated instead of
  // waiting for the whole structured object. Once the first res.write()
  // happens the HTTP status is locked in at 200 — so every failure from
  // this point on (a malformed tool call, a dropped connection mid-stream)
  // is reported as a {"type":"final"} frame carrying fallbackAnswer(...)
  // rather than a different status code. The client only ever needs to
  // handle two frame types: "answer_delta" (text so far) and "final" (the
  // complete, validated answer contract — including the fallback shape).
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  const writeFrame = (frame) => res.write(JSON.stringify(frame) + "\n");

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: STATIC_INSTRUCTIONS,
        cache_control: { type: "ephemeral" }
      },
      {
        type: "text",
        text: `<knowledge_base>\n${knowledgeBlock}\n</knowledge_base>`,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [...history, { role: "user", content: message }],
    tools: [ANSWER_TOOL],
    tool_choice: { type: "tool", name: ANSWER_TOOL_NAME }
  });

  const { data, isGenuineCannotAnswer } = await runChatStream(stream, writeFrame);

  // Only a real, well-formed "cannot_answer" counts as a knowledge gap —
  // never a technical-failure fallbackAnswer(), which is a server problem,
  // not missing content.
  if (isGenuineCannotAnswer) {
    try {
      appendGap(GAPS_LOG_PATH, {
        timestamp: new Date().toISOString(),
        question: message,
        answer: data.answer
      });
    } catch (err) {
      console.error("Failed to log knowledge gap:", err.message);
    }
  }

  res.end();
});

// Basic-auth-protected (same middleware as everything else, applied above)
// review page for questions the bot had no knowledge-base coverage for.
app.get("/admin/gaps", (req, res) => {
  const gaps = readGaps(GAPS_LOG_PATH);
  res.set("Content-Type", "text/html");
  res.send(renderGapsPage(gaps));
});

app.post("/api/feedback", (req, res) => {
  const validationError = validateFeedbackRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const { question, answer, rating } = req.body;
  const entry = { timestamp: new Date().toISOString(), question, answer, rating };
  try {
    appendFeedback(FEEDBACK_LOG_PATH, entry);
  } catch (err) {
    console.error("Failed to log feedback:", err.message);
    return res.status(500).json({ error: "Could not record feedback." });
  }

  // Fire-and-forget: an alert-email failure (bad credentials, SMTP host
  // down) must never affect the recorded feedback or the client response.
  if (rating === "down" && mailTransporter) {
    mailTransporter
      .sendMail(buildDownvoteAlertEmail(entry, process.env))
      .catch((err) => console.error("Failed to send downvote alert email:", err.message));
  }

  res.json({ ok: true });
});

// Basic-auth-protected review page for rep thumbs up/down feedback.
app.get("/admin/feedback", (req, res) => {
  const entries = readFeedback(FEEDBACK_LOG_PATH);
  res.set("Content-Type", "text/html");
  res.send(renderFeedbackPage(entries));
});

// Catch-all error handler: express routes body-parser failures (bad JSON,
// oversized body) here too. Never forward err.message/stack to the client —
// log server-side only.
app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ error: "Invalid request." });
});

app.listen(PORT, () => {
  console.log(`JDHG Product Q&A bot listening on http://localhost:${PORT}`);
  console.log(`Knowledge base: ${ALL_FILENAMES.length} files in ${KNOWLEDGE_DIR}`);
});
