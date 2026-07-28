// requestValidation.js
//
// Server-side validation for the /api/chat request body. Pure function, no
// express dependency, so it's directly unit-testable. Returns null when the
// body is valid, or a short human-readable error string (safe to send back
// to the client as-is — it never echoes anything from the request that
// could leak internals, just describes the shape violation).
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_HISTORY_MESSAGES = 40;
export const MAX_REQUEST_BODY_SIZE = "256kb";

const VALID_ROLES = new Set(["user", "assistant"]);

export function validateChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }

  const { message, history } = body;

  if (typeof message !== "string" || message.trim().length === 0) {
    return "message is required and must be a non-empty string.";
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `message exceeds the ${MAX_MESSAGE_LENGTH}-character limit.`;
  }

  if (history === undefined) {
    return null;
  }
  if (!Array.isArray(history)) {
    return "history must be an array.";
  }
  if (history.length > MAX_HISTORY_MESSAGES) {
    return `history exceeds the ${MAX_HISTORY_MESSAGES}-message limit.`;
  }

  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      return `history[${i}] must be an object.`;
    }
    if (!VALID_ROLES.has(turn.role)) {
      return `history[${i}].role must be "user" or "assistant".`;
    }
    if (typeof turn.content !== "string") {
      return `history[${i}].content must be a string.`;
    }
    if (turn.content.length > MAX_MESSAGE_LENGTH) {
      return `history[${i}].content exceeds the ${MAX_MESSAGE_LENGTH}-character limit.`;
    }
    const extraKeys = Object.keys(turn).filter((k) => k !== "role" && k !== "content");
    if (extraKeys.length > 0) {
      return `history[${i}] has unexpected field(s): ${extraKeys.join(", ")}.`;
    }
  }

  return null;
}
