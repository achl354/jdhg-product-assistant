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
import { ANSWER_TOOL, ANSWER_TOOL_NAME, fallbackAnswer, isWellFormedAnswer } from "./lib/answerContract.js";
import { STATIC_INSTRUCTIONS } from "./lib/prompt.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const PORT = process.env.PORT || 3000;
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
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

  try {
    const response = await client.messages.create({
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

    const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === ANSWER_TOOL_NAME);
    if (!toolUse || !isWellFormedAnswer(toolUse.input)) {
      console.error("Model response did not contain a well-formed provide_answer call.");
      return res.status(502).json(fallbackAnswer("the assistant's response could not be parsed"));
    }

    res.json(toolUse.input);
  } catch (err) {
    console.error("Chat request failed:", err.message);
    res.status(502).json(fallbackAnswer("failed to reach the assistant"));
  }
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
