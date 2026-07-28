// answerContract.js
//
// The structured shape every /api/chat response takes, and the Claude
// tool-use definition that forces the model to fill it in rather than
// returning free text we'd have to parse. Using a forced tool call (not just
// prompt instructions) means the shape is enforced by the API layer, not by
// hoping the model remembers to format its reply correctly.
export const ANSWER_STATUSES = ["confirmed", "supported", "needs_confirmation", "cannot_answer"];

export const ANSWER_TOOL_NAME = "provide_answer";

export const ANSWER_TOOL = {
  name: ANSWER_TOOL_NAME,
  description:
    "Provide a structured answer to the rep's question, grounded only in the attached knowledge documents. Always call this tool exactly once per reply.",
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "The full answer for the rep, including any caveats inline. This is the internal/complete version — see customer_ready for a customer-safe version."
      },
      status: {
        type: "string",
        enum: ANSWER_STATUSES,
        description:
          "confirmed = grounded in a current, approved manufacturer IFU/user manual or ARTG/regulatory document. " +
          "supported = grounded in approved marketing or internal operational material (not IFU/regulatory grade). " +
          "needs_confirmation = the knowledge base has incomplete, conflicting, or unapproved evidence for this specific claim — never upgrade this to confirmed/supported just because a document exists. " +
          "cannot_answer = the knowledge base does not cover this at all."
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "Knowledge document IDs (e.g. 'marketing/hygenica.md') this answer draws from. Empty array if status is cannot_answer."
      },
      internal_caveat: {
        type: ["string", "null"],
        description:
          "Internal-only guidance for the rep (e.g. 'confirm this weight limit with JDHG/Regulatory before quoting it — the source document doesn't disambiguate'). Never phrased for the customer to hear. Null if there is no caveat."
      },
      customer_ready: {
        type: "string",
        description:
          "A customer-safe, quotable phrasing of the answer alone, with no internal hedging/caveat language, suitable to read aloud or paste into an email. " +
          "Empty string if status is needs_confirmation or cannot_answer and nothing can be safely told to the customer yet."
      },
      related_documents: {
        type: "array",
        items: { type: "string" },
        description: "Other knowledge document IDs that might be relevant follow-ups. Empty array if none."
      }
    },
    required: ["answer", "status", "sources", "internal_caveat", "customer_ready", "related_documents"]
  }
};

// Used whenever we can't get a real structured answer from the model at all
// (API error, missing key, model didn't call the tool) — this shape must
// always be valid input for the UI, so the client never has to special-case
// "the API returned something malformed."
export function fallbackAnswer(reason) {
  return {
    answer: `I couldn't reach the assistant just now (${reason}). Please try again, and if it keeps happening, contact JD Healthcare Group directly.`,
    status: "cannot_answer",
    sources: [],
    internal_caveat: reason,
    customer_ready: "",
    related_documents: []
  };
}

// Defensive validation of whatever the model's tool_use.input actually
// contains, since a schema is a strong hint to the model, not a hard
// guarantee — never trust it blindly before sending to the client.
export function isWellFormedAnswer(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  if (typeof candidate.answer !== "string") return false;
  if (!ANSWER_STATUSES.includes(candidate.status)) return false;
  if (!Array.isArray(candidate.sources) || !candidate.sources.every((s) => typeof s === "string")) return false;
  if (candidate.internal_caveat !== null && typeof candidate.internal_caveat !== "string") return false;
  if (typeof candidate.customer_ready !== "string") return false;
  if (!Array.isArray(candidate.related_documents) || !candidate.related_documents.every((s) => typeof s === "string")) return false;
  return true;
}
