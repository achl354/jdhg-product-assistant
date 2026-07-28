# Re-syncing the marketing knowledge files from SharePoint

This folder (`knowledge/marketing/`) was built by pulling every file under the
JD Sales & Marketing Hub SharePoint site's `Shared Documents` library:

```
https://jdhealthcare.sharepoint.com/sites/JDSalesMarketingHub-MarketingMaterial/Shared Documents
```

## Why this isn't automated in the app itself

`server.js` deliberately has no live SharePoint/Graph API dependency (see the
top-level README) — it would need an Azure AD app registration and admin
consent, which this project intentionally avoids. So this folder is a
point-in-time export, the same way the HoverTech/TrenGuard files are, not a
live sync.

## How it was actually pulled

It was **not** scraped by a standalone script — it was done interactively, by
asking Claude (Claude Code, with a Microsoft 365 connector granting SharePoint
access for that session) to:

1. Search the SharePoint site for its folder structure (`sharepoint_folder_search`
   against the site name), to get the current list of brand/product folders.
2. Read each folder's file listing, then read each file's content — the
   Microsoft 365 MCP tools return already-extracted text for PDFs, so no
   separate PDF-parsing step was needed.
3. Clean up the extracted text (PDF extraction leaves odd spacing/kerning
   artefacts on some marketing PDFs) and write one markdown file per brand
   under `knowledge/marketing/`, in the same style as the rest of the
   knowledge base — preserving every product code, spec, and figure, and
   flagging discrepancies between source documents rather than silently
   picking one.
4. Add manifest rows to `knowledge/_sources.md` and keyword-router entries to
   `KNOWLEDGE_INDEX` in `server.js` for each new brand.

## How to re-run this later

Ask Claude Code (in a session with Microsoft 365 / SharePoint access) something like:

> Re-sync the marketing knowledge base from
> `https://jdhealthcare.sharepoint.com/sites/JDSalesMarketingHub-MarketingMaterial/Shared Documents`.
> Compare the current folder/file listing against `knowledge/_sources.md`,
> pull any new or changed files, regenerate the affected `knowledge/marketing/*.md`
> files following the existing format and trust-tier caveats, and update
> `_sources.md` and `KNOWLEDGE_INDEX` in `server.js` for anything new.

Two known gaps from the first pass (2026-07-28), worth checking on a re-sync:
- **Hygenica's "Info Pack" file** was too large to ingest in one read and was
  skipped — the booklet content captured is extensive but not necessarily
  exhaustive.
- **Raizer's "JD PROCare Service Flyer"** returned no extractable text
  (likely an image-only/scanned PDF) — would need a different extraction
  approach (e.g. OCR) if that content is needed.
