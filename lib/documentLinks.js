// documentLinks.js
//
// Attaches real, verified document links to an answer's already-cited
// sources/related_documents, by looking those knowledge-doc IDs up against
// knowledge/sources.meta.json's secure_document_link field.
//
// The model is NEVER the source of a URL — it only ever cites document IDs
// (the sources/related_documents fields it already produces via the
// provide_answer tool). This module runs entirely server-side, after the
// model's tool call has already resolved, and only ever surfaces a link that
// was actually verified against SharePoint during knowledge-base curation
// (see MARKETING_RESYNC.md and knowledge/sources.meta.json's own field
// glossary). A document with no verified link (secure_document_link still
// "needs_confirmation") simply contributes nothing — never a guessed or
// placeholder URL.
//
// secure_document_link in sources.meta.json is one of:
//   - the string "needs_confirmation" (unresolved — no link surfaced), or
//   - an array of { name, url } objects (one entry per physical source
//     document a knowledge file merges — most knowledge files map to a
//     single document, but some marketing files merge several PDFs).

// Returns the array of { name, url } link objects on file for a single
// knowledge doc ID, or [] if there's no sources.meta.json entry, or that
// entry's secure_document_link is still the unresolved "needs_confirmation"
// string (or any other non-array value).
export function linksForDocId(docId, sourcesMeta) {
  const entry = sourcesMeta?.sources?.[docId];
  if (!entry) return [];
  const link = entry.secure_document_link;
  if (!Array.isArray(link)) return [];
  return link.filter((l) => l && typeof l.name === "string" && typeof l.url === "string");
}

// Given a well-formed answer object (the model's provide_answer input, or
// fallbackAnswer()'s shape), returns a NEW object with a `document_links`
// field added: one entry per doc ID drawn from `sources` then
// `related_documents` (sources first, de-duplicated) that has at least one
// verified link on file, shaped as { docId, links: [{ name, url }, ...] }.
// Doc IDs with no verified link are omitted entirely — the UI never has to
// special-case an empty-links entry.
//
// Purely additive: never touches the fields the model itself controls
// (answer/status/sources/customer_ready/related_documents). A caller that
// doesn't know about document_links yet can simply ignore it.
export function attachDocumentLinks(data, sourcesMeta) {
  const docIds = [
    ...(Array.isArray(data?.sources) ? data.sources : []),
    ...(Array.isArray(data?.related_documents) ? data.related_documents : [])
  ];

  const seen = new Set();
  const document_links = [];
  for (const docId of docIds) {
    if (seen.has(docId)) continue;
    seen.add(docId);
    const links = linksForDocId(docId, sourcesMeta);
    if (links.length) document_links.push({ docId, links });
  }

  return { ...data, document_links };
}
