# JDHG Product Assistant — pilot

A small chat web app for JDHG reps to ask questions about JDHG's product range, grounded only in a curated set of vetted documents (see `knowledge/_sources.md` and `knowledge/sources.meta.json`). HoverTech and TrenGuard have full manufacturer IFU/usage manuals and ARTG certificates loaded; the rest of the catalogue (NetZero, Hygenica, Medsalv, MiniMaxx, AlbacMat, Carexia, I-MOVE, Trulife Pressurecare, Raizer, AMIGO PEM, Clavia, Easi Rider/Mover) currently has only marketing collateral (flyers/booklets/fact sheets) loaded — the bot is instructed to present that tier accordingly rather than imply IFU-grade certainty.

This document covers the pilot-hardening pass: cross-platform routing, the answer contract, source metadata, claim-level provenance, request/access hardening, and testing. For the original build rationale see the "Why it's built this way" section below, unchanged from the initial pilot.

## Why it's built this way

- **No live SharePoint search.** Live search would need an Azure AD app registration and admin consent to call Microsoft Graph — a real dependency this pilot deliberately avoids. Instead, the knowledge base is a one-time manual export of the current, vetted documents into `knowledge/*.md`.
- **No Teams/Bot Framework integration.** This is a plain web page + API, so it can run and be tested immediately. It can be embedded as a Teams tab later, or wired into a real Bot Framework bot once there's Azure access — neither is required to use it today.
- **Refuses rather than guesses.** The system prompt (`lib/prompt.js`) instructs the model to answer only from the provided documents and say so explicitly when something isn't covered, rather than fall back on general knowledge — important for ARTG/compliance-sensitive answers.
- **Keyword-routed knowledge, not a flat dump.** Sending the entire knowledge base on every message gets expensive as more product lines are added. A keyword router (`KNOWLEDGE_INDEX` in `lib/knowledgeStore.js`) picks only the files relevant to the question — plus the last couple of turns, so follow-ups still work — and falls back to the full set if nothing matches, rather than risk a wrong "not in my knowledge base." Adding a new knowledge file means adding a matching entry to `KNOWLEDGE_INDEX` too.

## Code layout

Business logic lives in `lib/`, independent of Express and the live Anthropic API, so it can be unit-tested directly (see `test/`):

- `lib/knowledgeStore.js` — loads `knowledge/**/*.md`, builds cross-platform knowledge IDs, keyword routing, startup validation that every indexed file exists.
- `lib/requestValidation.js` — server-side validation of the `/api/chat` request body.
- `lib/auth.js` — basic-auth gate and the production fail-fast startup check.
- `lib/answerContract.js` — the `provide_answer` tool schema, the fallback answer shape, and defensive validation of the model's output.
- `lib/prompt.js` — the system prompt / operating rules given to the model.
- `lib/gapLog.js` — append-only log of questions with no knowledge-base coverage, plus the `/admin/gaps` review page (see below).
- `lib/feedbackLog.js` — append-only log of per-answer thumbs up/down feedback, plus the `/admin/feedback` review page.
- `lib/chatStream.js` — orchestrates one streamed chat turn against an Anthropic `MessageStream`-shaped object, decoupled from Express/the live SDK so it's unit-testable with a fake stream.
- `lib/streamingAnswer.js` — incrementally extracts the growing `answer` string out of the model's still-in-progress tool-call JSON, so the UI can reveal it as it's generated.
- `server.js` — wires the above into an Express app; no business logic of its own.

## Knowledge routing (cross-platform)

Knowledge IDs (e.g. `marketing/hygenica.md`) are always built with a literal forward slash via template strings, never with `path.join`/`path.sep`. `path.join` is only used to build the actual filesystem path passed to `fs.readFileSync`. This means an ID is identical on Windows and Linux by construction — there's no OS-conditional code path to get wrong, so a single Linux test run is sufficient evidence for both platforms (see `test/knowledgeStore.test.js`, including a regression test that reproduces the old `path.join`-based bug via `path.win32.join` and confirms the fixed loader doesn't produce it).

At startup, `findMissingKnowledgeFiles` checks every file referenced by `KNOWLEDGE_INDEX` (and `ALWAYS_INCLUDE`) actually exists in the loaded knowledge map. If anything is missing, the server logs a clear error naming the missing file(s) and exits (`process.exit(1)`) rather than starting in a broken state. A question that doesn't match any keyword still falls back to sending the full knowledge set, so an unmatched question never produces a false "not in my knowledge base."

## The answer contract

`/api/chat` always returns a structured JSON object, never free text, enforced by forcing the model to call the `provide_answer` tool (`lib/answerContract.js`) rather than relying on prompt instructions alone:

| Field | Meaning |
|---|---|
| `answer` | Full internal answer, including any caveats inline. |
| `status` | One of `confirmed` / `supported` / `needs_confirmation` / `cannot_answer` (see below). |
| `sources` | Knowledge document IDs the answer draws from. |
| `customer_ready` | A customer-safe, quotable version of the answer with no internal hedging — empty string if nothing can be safely told to a customer yet. |
| `related_documents` | Other document IDs that might be relevant follow-ups. |

The response is validated twice: once by the Claude tool schema itself, and again server-side by `isWellFormedAnswer` before it's ever sent to the browser — if either the model doesn't call the tool or the output doesn't match the expected shape, the server returns `fallbackAnswer(...)` (always `status: "cannot_answer"`) instead of passing through anything unvalidated.

In the UI (`public/index.html`), each bot reply renders as a coloured status badge, the answer (with real markdown rendering — headings/bold/lists, not raw `#`/`**` symbols), a sources line, and — only when present — a blue "copy-ready customer wording" box with a one-click Copy button. An earlier separate amber "internal caveat" box was removed after pilot feedback — any internal caveat now stays inline in the main answer text (which was always the field's design — "the full answer, including any caveats inline"), rather than a second box. The interface is a single, focused chat column — no sidebar/quick-links — kept deliberately simple after early pilot feedback that a topic-picker sidebar wasn't adding value either.

`customer_ready` is instructed (`lib/prompt.js` rule 7) to never cite the source mid-sentence (no "per the manufacturer's care guide..." woven into the message) — instead it ends with the source on its own final line, formatted exactly as `Reference: <document name>`, separated from the body by a blank line. The client (`renderCustomerReady` in `public/index.html`) detects that trailing line and renders it as a small muted italic footer with a subtle divider, distinct from the main message, rather than as a regular paragraph — falling back to plain rendering if a reply doesn't follow the format, so this never breaks on an unexpected shape.

## Streaming responses

`/api/chat` streams the answer as the model generates it, rather than making the rep wait for the entire structured response (status, sources, customer-ready wording, etc.) before seeing anything. The response body is newline-delimited JSON (`Content-Type: application/x-ndjson`) — a sequence of `{"type":"answer_delta","text":"..."}` frames carrying the growing answer text, followed by exactly one `{"type":"final","data":{...}}` frame carrying the complete, validated answer contract (or `fallbackAnswer(...)` on any failure — the client only ever needs to understand these two frame types).

This is real token-level streaming, not a simulated typewriter effect — but it took an extra step to get right. The Anthropic SDK's own convenience event for streaming tool-call input (`stream.on("inputJson", (partialJson, jsonSnapshot) => ...)`) turned out to be unsuitable for revealing the `answer` field character-by-character: its vendored partial-JSON parser discards a string value entirely until its closing quote has arrived, so `jsonSnapshot.answer` jumps straight from `undefined` to the complete string in one shot rather than growing incrementally. `lib/streamingAnswer.js` instead accumulates the event's raw incremental JSON text itself and extracts the `answer` field's decoded content so far — including while its closing quote hasn't arrived yet — which is what actually produces the progressive reveal. `lib/chatStream.js` orchestrates this against a stream-shaped object (`on`/`finalMessage`), which is unit-tested with a fake stream (`test/chatStream.test.js`, `test/streamingAnswer.test.js`) rather than requiring a real API key.

Once the first `res.write()` happens the HTTP status is locked at 200, so any failure from that point on (a malformed tool call, a dropped connection mid-stream) is reported as a `"final"` frame carrying `fallbackAnswer(...)`, not a different status code.

## Feedback and knowledge-gap logging (`/admin/gaps`, `/admin/feedback`)

### Flagged knowledge gaps (`/admin/gaps`)

Whenever the model returns a real, well-formed `status: "cannot_answer"` (the knowledge base genuinely has nothing on the topic — not a technical failure like a missing API key, and not `needs_confirmation`, which already has material, just conflicting/incomplete), the server appends an entry — timestamp, the question, and the answer given — to `data/knowledge-gaps.jsonl`. Visit `/admin/gaps` (behind the same basic-auth login reps use) to review flagged questions and decide what new knowledge content to add.

This is a log-and-review mechanism, not a live notification — nothing is emailed or pushed anywhere automatically. Two things worth knowing:
- **Ephemeral disk**: on a host like Render, `data/knowledge-gaps.jsonl` is wiped whenever a new deploy creates a fresh filesystem (not on sleep/wake, only on redeploys). Fine for a pilot; if gap history needs to survive redeploys long-term, move it to a small database or external store later.
- **No email/Slack alerting yet** — deliberately deferred until there's a mail-sending account (SMTP credentials or a transactional email provider) to wire up; the log-and-review page needs no such setup and works immediately.

### Rep feedback (`/admin/feedback`)

Every bot reply (including fallback/error answers) shows a 👍/👎 row. Clicking one POSTs `{question, answer, rating}` to `/api/feedback` (validated by `lib/feedbackLog.js`'s `validateFeedbackRequest`, same length-limited pattern as chat request validation) and appends it to `data/feedback.jsonl`. `/admin/feedback` (same basic-auth login) lists entries newest-first with a helpful/not-helpful count, so a 👎 on an answer the bot was actually confident about (as opposed to a `cannot_answer` the gap log already catches) still surfaces for review. The same ephemeral-disk caveat as the gap log applies.

### The four statuses

- **confirmed** — grounded in a current, approved manufacturer IFU/user manual or ARTG/regulatory document, with no unresolved conflict between sources.
- **supported** — grounded in approved marketing or internal operational material — real JDHG content, but not IFU/regulatory grade.
- **needs_confirmation** — the evidence for this specific claim is incomplete, conflicting between sources (or internally ambiguous within one source), or unapproved. This is not "the model is slightly unsure" — it's used whenever a knowledge file itself flags a discrepancy, even if a single plausible-sounding answer could be constructed. The model is explicitly instructed never to silently pick one interpretation and present it as settled.
- **cannot_answer** — the knowledge base doesn't cover this at all.

Document type sets an upper bound on status: marketing collateral (flyers, booklets, fact sheets, sales positioning) can support `supported` at most, never `confirmed` — this is enforced both in the system prompt and, at the metadata layer, by a test asserting no `marketing_collateral` source is ever tagged `authority_level: confirmed`.

## Source metadata (`knowledge/sources.meta.json`)

Human-edited prose knowledge (`knowledge/**/*.md`) is kept separate from a generated, machine-readable metadata file, `knowledge/sources.meta.json`, with one entry per knowledge file covering: source document name, document type, revision/version, document date, page/section, authority level, approval status, approver/owner, last-reviewed date, external-use permission, current/superseded status, known location, secure document link, and a `known_conflicts` array. The file's own `$schema_notes.field_glossary` documents what each field means.

**Nothing is invented.** No formal JDHG document-approval workflow, named approver, external-use clearance, or stable document-control link was available for any source at ingestion time — so `approval_status`, `approver_owner`, `external_use_permission`, and `secure_document_link` are `"needs_confirmation"` for every single entry, including the pre-existing HoverTech/TrenGuard sources. A test (`test/sourceProvenance.test.js`) enforces this stays true rather than silently regressing to a guessed value later.

## Claim-level provenance

Where a single knowledge file merges multiple source PDFs, per-section `*Source: ...*` tags attribute each fact to the specific document it came from (e.g. `knowledge/marketing/hygenica.md`, `imove.md`, `raizer.md`, `clavia.md`, `trulife-pressurecare.md`, `netzero.md`, `medsalv.md`). Where two sources for the same product disagreed rather than merely covering different sections, the file was split instead (AlbacMat's flyer and 2019 manual are now two separate files, each flagging the other's conflicting safe-working-load figure) or a dedicated "NEEDS CONFIRMATION" section was added inline (Carexia's Trendelenburg-vs-fully-reclined ambiguity).

### The Carexia weight-limit conflict

The source flyer (`JDHG Flyer - Carexia FPVE - JDHG121124.pdf`) states "135kg in Trendelenburg position" in its feature bullets and, separately, "Safe working load (fully reclined): 135kg" in its specification table. Trendelenburg tilt (the whole chair angled head-down) and the backrest being fully reclined (its own separate recline-angle spec) are not necessarily the same physical state, and the source document never disambiguates which one — or both — the 135kg figure applies to. No other source document was available to resolve it. Per the requirement not to choose an interpretation ourselves: `knowledge/marketing/carexia.md` and `knowledge/sources.meta.json` both mark this `needs_confirmation`, and the bot is instructed (`lib/prompt.js`, rule 4) to tell the rep to confirm the exact condition with JDHG/Regulatory before quoting either interpretation to a customer — never to pick the plausible-sounding one itself. This is covered by an explicit test in `test/sourceProvenance.test.js`.

## Interface polish

- **Auto-resizing input.** The message box is a `<textarea>` that grows with content (capped at ~140px, then scrolls). Enter sends; Shift+Enter inserts a newline.
- **Smart auto-scroll.** New messages only snap the log to the bottom if the rep was already scrolled near the bottom — if they've scrolled up to reread something, an incoming reply doesn't yank them back down. Sending a message always scrolls (expected — it's their own outgoing message).
- **Conversation persistence.** The full conversation (both the Anthropic-format `history` used for API context and a `displayLog` capturing exactly what was rendered, including status/sources/customer-ready content) is saved to `localStorage` after every turn and replayed on page load, so a refresh doesn't lose the conversation. Falls back to a fresh greeting if nothing is saved or the saved shape doesn't parse.
- **Dark mode.** Follows the OS/browser's `prefers-color-scheme` automatically — no manual toggle, no separate theme to maintain per component (colors are CSS custom properties, overridden as a block in a `@media (prefers-color-scheme: dark)` rule).
- **Favicon.** An inline SVG data URI matching the existing navy "JD" brand mark already used in the header avatar — no external asset/network request.
- **Accessibility.** `role="log"` on the message list; a visually-hidden `aria-live="polite"` region announces "Assistant replied" once a reply completes (deliberately not wired to every streaming delta, which would spam screen readers mid-stream); visible `:focus-visible` outlines on all interactive elements; `aria-label`s on the thumbs up/down buttons.
- **Micro-interactions.** Buttons get a subtle press (`scale(0.96)`) and hover-background transition rather than an instant, static state change.

## Access control and request hardening

- **Production fails closed.** At startup, `assertAuthConfigured` (`lib/auth.js`) checks `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`. If `NODE_ENV=production` and both aren't set, the server logs a clear error and exits — it will not silently start wide open. The only way to run production without credentials is the explicit `ALLOW_UNAUTHENTICATED=true` escape hatch, meant as a deliberate, temporary choice, never a default.
- Outside production (local development), running without credentials is allowed with a logged warning, so `npm start` still works out of the box for local testing.
- **Request validation** (`lib/requestValidation.js`, enforced before anything else in `/api/chat`): `message` must be a non-empty string up to 4000 characters; `history` (if present) must be an array of up to 40 entries, each `{ role: "user"|"assistant", content: string }` with content up to 4000 characters and no extra fields. Anything malformed returns HTTP 400 with a short, generic description — never echoing request content back or leaking internals.
- **Request body size** is capped (`express.json({ limit: "256kb" })`) independently of the message-length check, so an oversized raw body is rejected before JSON parsing.
- **No secrets or stack traces reach the browser.** The catch-all Express error handler logs `err.message` server-side only and always responds with a generic `{ error: "Invalid request." }`; the chat handler's own catch block does the same, returning `fallbackAnswer(...)` rather than the underlying Anthropic API error.

## Run it locally

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Then open http://localhost:3000. Without `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` set, it runs open — fine for local testing, not for anything deployed. Set `NODE_ENV=production` to exercise the production fail-fast path.

## Testing

```bash
npm test
```

Runs Node's built-in test runner (`node --test`, no extra dependency) over everything in `test/`. Covers: every `KNOWLEDGE_INDEX`/`ALWAYS_INCLUDE` file actually exists on disk; the Windows/Linux knowledge-ID regression (including a direct reproduction of the old `path.join`-based bug via `path.win32.join`, proving the fixed loader no longer produces backslash-separated IDs); "Hygenica" routing to `marketing/hygenica.md`; at least one routing test question per `KNOWLEDGE_INDEX` entry; follow-up questions retaining product context via recent history; an unmatched question falling back to the full knowledge set; the full request-validation matrix (message/history length, malformed roles, non-string content, extra fields); the auth startup gate (configured / dev-mode / production-without-override / explicit override) and the basic-auth middleware itself; the `provide_answer` contract (schema requiredness, status enum, `isWellFormedAnswer` rejecting every malformed shape); the source-provenance rules (metadata schema completeness, no invented approval/owner/permission/link fields, marketing collateral never marked `confirmed`, the Carexia and AlbacMat conflicts staying flagged, and the system prompt's anti-silent-resolution instructions); the knowledge-gap log and feedback log (`appendGap`/`readGaps`/`appendFeedback`/`readFeedback` round-tripping entries correctly, newest-first ordering, request validation, and HTML-escaping so a malicious question can't inject markup into either admin page); and the streaming pipeline (`lib/streamingAnswer.js`'s incremental JSON-string extraction — partial content before the closing quote, escape-sequence decoding, graceful handling of a chunk boundary landing mid-escape-sequence — and `lib/chatStream.js`'s frame sequencing against a fake stream, including that a genuine model `cannot_answer` is distinguished from a technical-failure `fallbackAnswer()` so only real knowledge gaps get logged).

The streaming pipeline was also verified against a real end-to-end request: a throwaway fake `/v1/messages` SSE server was pointed at via `ANTHROPIC_BASE_URL` (which the SDK reads natively) so the actual `client.messages.stream()` call, `lib/chatStream.js`, and the browser's NDJSON-reading loop in `public/index.html` all ran for real, confirming the answer genuinely reveals character-by-character in the browser rather than arriving in one block.

## Deploying to Render

1. Push this repo to GitHub.
2. In Render: New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`. Render sets `PORT` automatically — the app already reads it.
4. Under Environment, add:
   - `ANTHROPIC_API_KEY` — required.
   - `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` — required for anything other than local testing. Pick a shared username/password for reps; without both set, the app runs with no access control at all.
   - `ANTHROPIC_MODEL` — optional, defaults to `claude-sonnet-4-5-20250929`. Set to `claude-haiku-4-5-20251001` for meaningfully lower cost — side-by-side testing on this knowledge base showed no quality drop on spec lookups, procedural walkthroughs, or the out-of-scope/source-conflict cases that matter most here.
5. Deploy. Render gives you a `https://<name>.onrender.com` URL — that's what you'd share with reps (behind the basic-auth prompt their browser will show once).

Free/starter Render tiers sleep after inactivity and take a few seconds to wake on the next request — fine for a pilot, worth upgrading if that latency becomes annoying.

## Updating the knowledge base

Edit or add files under `knowledge/`. Each file should be a self-contained markdown document. Update `knowledge/_sources.md` with where the content came from and its date, so the bot's citations stay accurate. Restart the server to pick up changes (loaded once at startup). `knowledge/marketing/` is pulled from a SharePoint site rather than hand-written — see `MARKETING_RESYNC.md` for how to refresh it.

## Known limitations (pilot scope)

- HoverTech and TrenGuard have full IFU/manual/ARTG-grade documentation. The rest of the catalogue (see `knowledge/marketing/`) currently has marketing collateral only — flyers, booklets, fact sheets pulled from the JD Sales & Marketing Hub SharePoint site — not manufacturer IFUs or ARTG certificates. Real IFU/manual documents for these lines can be dropped in later following the same pattern as HoverTech/TrenGuard.
- Deliberately excludes the ~100-file legacy `Info From Suppliers/HoverTech (Supplier) Info` SharePoint archive (2011-2024) and the scattered per-hospital TrenGuard evaluation forms/quotes (2019-2021) sitting in individual rep folders — the bot will say it doesn't have something if it's only in that older material.
- For TrenGuard, JDHG's 2024 User Guide is treated as authoritative over the manufacturer's original 2015 IFU where they conflict — see the note in `knowledge/trenguard-usage-and-ifu.md`.
- Basic auth (single shared username/password) only — fine for a small pilot, not real per-user access control or audit logging. Revisit if this becomes permanent.
- Conversation persistence is per-browser `localStorage`, not server-side — clearing browser data or switching devices loses history; there's no cross-device sync or server-side transcript storage.

## Unresolved knowledge gaps and sources requiring human approval

This is the explicit deliverable for pilot sign-off — everything here needs a human decision before the bot's coverage can be considered fully settled. Full detail for each item lives in `knowledge/sources.meta.json` (`known_conflicts` per source).

### Approval / governance gap affecting every single source (24/24)

No formal JDHG document-approval workflow, named approver/owner, external-use (customer-facing) clearance, or stable document-control link exists in the systems this pilot had access to, for **any** source — including the pre-existing HoverTech and TrenGuard IFUs/ARTG certificates. Concretely, `approval_status`, `approver_owner`, `external_use_permission`, and `secure_document_link` are `needs_confirmation` for every entry in `knowledge/sources.meta.json`. Before this pilot is used to produce customer-facing wording at scale, JDHG/Regulatory should confirm, per source (or per document type as a shortcut): who is the approving owner, whether it's cleared for external/customer use, and where its authoritative, stable copy lives.

### Specific factual conflicts requiring a human decision

1. **Carexia FPVE weight limit (`marketing/carexia.md`)** — the source flyer states "135kg in Trendelenburg position" and, separately, "safe working load (fully reclined): 135kg," without clarifying whether these describe the same condition, two different conditions, or both simultaneously. **Needs confirmation with JDHG/Regulatory** — the bot will not quote either interpretation as settled until this is resolved.
2. **AlbacMat safe working load (`marketing/albacmat-flyer.md` vs `marketing/albacmat-manual-2019.md`)** — the current JDHG flyer states 470kg SWL; the 2019 manufacturer manual states 500kg SWL with a 160kg *tested* safe load. Which figure is current/authoritative is unresolved, and the manual's 2019 date is itself unconfirmed as the latest manufacturer edition. **Needs confirmation with JDHG/the manufacturer.**
3. **I-MOVE EZ-GO Bariatric product code (`marketing/imove.md`)** — appears as both `CFBM-EZTRSOv2` and `CFBM-EZTSROv2` across two source flyers. Likely a typo in one, but which one is unconfirmed. **Needs confirmation with JDHG before quoting a code to a customer.**
4. **TrenGuard 600 Hybrid procedure pack ARTG number (`trenguard-artg-and-regulatory.md`)** — only the 450 Hybrid pack's ARTG number (290464) was found in the documents reviewed; the 600 Hybrid pack's own number could not be confirmed. **Needs confirmation with Regulatory.**
5. **Medsalv remanufactured-device ARTG number (`marketing/medsalv.md`)** — the source flyers state remanufactured devices carry their own ARTG listing but don't give the number. **Needs confirmation with Medsalv/Regulatory.**
6. **Carexia source PDF date conflict (`marketing/carexia.md`)** — the same source PDF carries two different date codes (JDHG121124 on the main flyer, JDHG140524 on the specifications page), unreconciled. Low materiality (doesn't affect product facts) but flagged for completeness.

### Content gaps (not conflicts, but incomplete ingestion)

7. **Hygenica "Info Pack" PDF (`marketing/hygenica.md`)** — exceeded this ingestion pass's size/token limit and was not fully processed. The booklet content captured is extensive but not confirmed exhaustive for this specific document.
8. **Raizer JD PROCare Service Flyer (`marketing/raizer.md`)** — returned no extractable text (likely a scanned/image-only PDF) and was not ingested at all. A rep asking about JD PROCare servicing specifics should be told this isn't covered yet.

### Statistics/claims sourced from marketing material, not independently verified by JDHG

These are already labelled in-file as reported/marketing claims (not settled fact) and don't block pilot use, but are listed here for completeness since they came from vendor/distributor material rather than JDHG's own verification: NetZero's landfill-volume and emissions-reduction figures; Medsalv's "92% waste reduction"/"75% blended content" figures and B-Corp/Climate-Positive claims; the competitive-positioning "~750,000 procedures globally" figure; and Trulife's cited pressure-injury prevalence statistics (2006–2009 studies — old, not current Australian data).
