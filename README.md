# JDHG Product Assistant — pilot

A small chat web app for JDHG reps to ask questions about the HoverTech range and TrenGuard, grounded only in a curated set of vetted documents (see `knowledge/_sources.md`).

## Why it's built this way

- **No live SharePoint search.** Live search would need an Azure AD app registration and admin consent to call Microsoft Graph — a real dependency this pilot deliberately avoids. Instead, the knowledge base is a one-time manual export of the current, vetted documents into `knowledge/*.md`.
- **No Teams/Bot Framework integration.** This is a plain web page + API, so it can run and be tested immediately. It can be embedded as a Teams tab later, or wired into a real Bot Framework bot once there's Azure access — neither is required to use it today.
- **Refuses rather than guesses.** The system prompt in `server.js` instructs the model to answer only from the provided documents and say so explicitly when something isn't covered, rather than fall back on general knowledge — important for ARTG/compliance-sensitive answers.
- **Keyword-routed knowledge, not a flat dump.** Sending the entire knowledge base on every message gets expensive as more product lines are added. A keyword router (`KNOWLEDGE_INDEX` in `server.js`) picks only the files relevant to the question — plus the last couple of turns, so follow-ups still work — and falls back to the full set if nothing matches, rather than risk a wrong "not in my knowledge base." Adding a new knowledge file means adding a matching entry to `KNOWLEDGE_INDEX` too.

## Run it locally

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Then open http://localhost:3000. Without `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` set, it runs open — fine for local testing, not for anything deployed.

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

Edit or add files under `knowledge/`. Each file should be a self-contained markdown document. Update `knowledge/_sources.md` with where the content came from and its date, so the bot's citations stay accurate. Restart the server to pick up changes (loaded once at startup).

## Known limitations (pilot scope)

- HoverTech and TrenGuard only — no other product lines.
- Deliberately excludes the ~100-file legacy `Info From Suppliers/HoverTech (Supplier) Info` SharePoint archive (2011-2024) and the scattered per-hospital TrenGuard evaluation forms/quotes (2019-2021) sitting in individual rep folders — the bot will say it doesn't have something if it's only in that older material.
- For TrenGuard, JDHG's 2024 User Guide is treated as authoritative over the manufacturer's original 2015 IFU where they conflict — see the note in `knowledge/trenguard-usage-and-ifu.md`.
- Basic auth (single shared username/password) only — fine for a small pilot, not real per-user access control or audit logging. Revisit if this becomes permanent.
- No conversation persistence — history only lives in the browser tab.
