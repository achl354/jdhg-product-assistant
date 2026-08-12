import { test } from "node:test";
import assert from "node:assert/strict";

import { linksForDocId, attachDocumentLinks } from "../lib/documentLinks.js";

function meta(overrides) {
  return { sources: overrides };
}

test("linksForDocId returns [] when there's no sources.meta.json entry for the doc ID", () => {
  assert.deepEqual(linksForDocId("nonexistent.md", meta({})), []);
});

test("linksForDocId returns [] when secure_document_link is still needs_confirmation", () => {
  const sourcesMeta = meta({ "some-doc.md": { secure_document_link: "needs_confirmation" } });
  assert.deepEqual(linksForDocId("some-doc.md", sourcesMeta), []);
});

test("linksForDocId returns the real links when secure_document_link is a resolved array", () => {
  const links = [{ name: "Flyer.pdf", url: "https://jdhealthcare.sharepoint.com/Flyer.pdf" }];
  const sourcesMeta = meta({ "some-doc.md": { secure_document_link: links } });
  assert.deepEqual(linksForDocId("some-doc.md", sourcesMeta), links);
});

test("linksForDocId filters out malformed link entries rather than passing them through", () => {
  const sourcesMeta = meta({
    "some-doc.md": {
      secure_document_link: [
        { name: "Good.pdf", url: "https://jdhealthcare.sharepoint.com/Good.pdf" },
        { name: "Missing URL" },
        { url: "https://jdhealthcare.sharepoint.com/MissingName.pdf" },
        null
      ]
    }
  });
  assert.deepEqual(linksForDocId("some-doc.md", sourcesMeta), [
    { name: "Good.pdf", url: "https://jdhealthcare.sharepoint.com/Good.pdf" }
  ]);
});

test("attachDocumentLinks adds a document_links entry only for cited doc IDs that have a resolved link", () => {
  const sourcesMeta = meta({
    "linked.md": { secure_document_link: [{ name: "Linked.pdf", url: "https://jdhealthcare.sharepoint.com/Linked.pdf" }] },
    "unlinked.md": { secure_document_link: "needs_confirmation" }
  });
  const data = {
    answer: "...",
    status: "confirmed",
    sources: ["linked.md", "unlinked.md"],
    customer_ready: "",
    related_documents: []
  };

  const result = attachDocumentLinks(data, sourcesMeta);

  assert.deepEqual(result.document_links, [
    { docId: "linked.md", links: [{ name: "Linked.pdf", url: "https://jdhealthcare.sharepoint.com/Linked.pdf" }] }
  ]);
  // Purely additive — every model-controlled field must be untouched.
  assert.equal(result.answer, data.answer);
  assert.equal(result.status, data.status);
  assert.deepEqual(result.sources, data.sources);
  assert.deepEqual(result.related_documents, data.related_documents);
});

test("attachDocumentLinks draws from both sources and related_documents, sources first, de-duplicated", () => {
  const sourcesMeta = meta({
    "a.md": { secure_document_link: [{ name: "A.pdf", url: "https://jdhealthcare.sharepoint.com/A.pdf" }] },
    "b.md": { secure_document_link: [{ name: "B.pdf", url: "https://jdhealthcare.sharepoint.com/B.pdf" }] }
  });
  const data = {
    answer: "...",
    status: "confirmed",
    sources: ["a.md"],
    customer_ready: "",
    related_documents: ["a.md", "b.md"] // "a.md" repeated — must not duplicate
  };

  const result = attachDocumentLinks(data, sourcesMeta);

  assert.deepEqual(result.document_links, [
    { docId: "a.md", links: [{ name: "A.pdf", url: "https://jdhealthcare.sharepoint.com/A.pdf" }] },
    { docId: "b.md", links: [{ name: "B.pdf", url: "https://jdhealthcare.sharepoint.com/B.pdf" }] }
  ]);
});

test("attachDocumentLinks returns an empty document_links array when nothing is cited or nothing resolves", () => {
  const sourcesMeta = meta({});
  const data = { answer: "...", status: "cannot_answer", sources: [], customer_ready: "", related_documents: [] };
  assert.deepEqual(attachDocumentLinks(data, sourcesMeta).document_links, []);
});

test("attachDocumentLinks tolerates a missing/malformed sourcesMeta rather than throwing", () => {
  const data = { answer: "...", status: "confirmed", sources: ["a.md"], customer_ready: "", related_documents: [] };
  assert.deepEqual(attachDocumentLinks(data, undefined).document_links, []);
  assert.deepEqual(attachDocumentLinks(data, {}).document_links, []);
});
