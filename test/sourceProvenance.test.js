import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { loadAllKnowledgeFiles, KNOWLEDGE_INDEX, ALWAYS_INCLUDE } from "../lib/knowledgeStore.js";
import { STATIC_INSTRUCTIONS } from "../lib/prompt.js";

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const SOURCES_META_PATH = path.join(KNOWLEDGE_DIR, "sources.meta.json");
const sourcesMeta = JSON.parse(fs.readFileSync(SOURCES_META_PATH, "utf-8"));
const KNOWLEDGE_FILES = loadAllKnowledgeFiles(KNOWLEDGE_DIR);

const ALL_KNOWLEDGE_IDS = new Set([...KNOWLEDGE_INDEX.map((e) => e.file), ...ALWAYS_INCLUDE]);

const REQUIRED_META_FIELDS = [
  "source_document_name",
  "document_type",
  "revision_version",
  "document_date",
  "page_or_section",
  "authority_level",
  "approval_status",
  "approver_owner",
  "last_reviewed_date",
  "external_use_permission",
  "current_or_superseded",
  "known_location",
  "secure_document_link",
  "known_conflicts"
];

test("sources.meta.json has a machine-readable entry for every knowledge file", () => {
  for (const id of ALL_KNOWLEDGE_IDS) {
    assert.ok(sourcesMeta.sources[id], `expected sources.meta.json to have an entry for ${id}`);
  }
});

test("every sources.meta.json entry has the full required metadata schema (no missing fields)", () => {
  for (const [id, entry] of Object.entries(sourcesMeta.sources)) {
    for (const field of REQUIRED_META_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `expected ${id} to have field "${field}"`);
    }
    assert.ok(Array.isArray(entry.known_conflicts), `expected ${id}.known_conflicts to be an array`);
  }
});

test("marketing_collateral sources are never classified with a confirmed (IFU/regulatory-grade) authority_level", () => {
  for (const [id, entry] of Object.entries(sourcesMeta.sources)) {
    if (entry.document_type === "marketing_collateral") {
      assert.notEqual(entry.authority_level, "confirmed", `${id} is marketing_collateral and must not be authority_level "confirmed"`);
    }
  }
});

test("no source entry invents an approval workflow that was never actually confirmed", () => {
  // Per the ingestion rule: no formal JDHG approval record, named approver,
  // or external-use clearance was available for any source at ingestion
  // time, so these fields must stay needs_confirmation everywhere rather
  // than being guessed at. secure_document_link is different — it's since
  // been populated with real, verified links for documents whose canonical
  // SharePoint copy was located (see the next two tests) — so it's checked
  // separately, for shape rather than for a fixed value.
  for (const [id, entry] of Object.entries(sourcesMeta.sources)) {
    for (const field of ["approval_status", "approver_owner", "external_use_permission"]) {
      assert.equal(entry[field], "needs_confirmation", `expected ${id}.${field} to be "needs_confirmation", got "${entry[field]}"`);
    }
  }
});

test("every secure_document_link is either 'needs_confirmation' or a non-empty array of real {name, url} links", () => {
  // Guards the shape documentLinks.js relies on: never a bare string URL,
  // never an empty array pretending to be "resolved", never a link object
  // missing a field. A model never writes to this file, so this is purely a
  // data-integrity check on human/tooling-curated content.
  for (const [id, entry] of Object.entries(sourcesMeta.sources)) {
    const link = entry.secure_document_link;
    if (link === "needs_confirmation") continue;
    assert.ok(Array.isArray(link) && link.length > 0, `expected ${id}.secure_document_link to be "needs_confirmation" or a non-empty array, got ${JSON.stringify(link)}`);
    for (const entry2 of link) {
      assert.equal(typeof entry2.name, "string", `expected every link on ${id} to have a string name`);
      assert.ok(entry2.name.length > 0, `expected every link name on ${id} to be non-empty`);
      assert.match(entry2.url, /^https:\/\/jdhealthcare(-my)?\.sharepoint\.com\//, `expected every link url on ${id} to be a jdhealthcare SharePoint URL, got "${entry2.url}"`);
    }
  }
});

test("documents with no findable canonical SharePoint copy stay needs_confirmation rather than a guessed link", () => {
  // These specific entries were searched for during the document-links
  // effort (2026-08-12) and deliberately left unresolved: either no
  // canonical shared-library copy exists (only personal OneDrive/draft
  // copies), the correct document itself is ambiguous, or the source isn't
  // a shareable file at all. Regressing any of these to a fabricated link
  // would be worse than leaving it unresolved.
  const expectedUnresolved = [
    "_sources.md", // the manifest itself, not a product document
    "artg-certificate.md", // only a personal-OneDrive copy found
    "end-of-service-guidance.md", // only a draft .docx found
    "product-range-and-faq.md", // internal training summary, not a single shareable file
    "competitive-positioning-hovermatt-trenguard.md", // a Teams chat message, not a file
    "easiair-usage-and-ifu.md", // only drafts/personal-OneDrive copies found
    "easimove-artg-and-regulatory.md", // the confirmed ARTG number (528531) has no findable link; the other (343300) is not confirmed to apply
    "easimove-validation-summary.md", // only Teams-chat-file/personal-OneDrive copies found
    "competitive-positioning-easimove.md" // Document 1 is INTERNAL USE ONLY; never link it externally
  ];
  for (const id of expectedUnresolved) {
    assert.equal(sourcesMeta.sources[id].secure_document_link, "needs_confirmation", `expected ${id}.secure_document_link to still be "needs_confirmation"`);
  }
});

test("Carexia's weight-limit ambiguity is flagged needs_confirmation, not resolved to one interpretation", () => {
  const carexiaMeta = sourcesMeta.sources["marketing/carexia.md"];
  assert.ok(carexiaMeta.known_conflicts.length > 0, "expected marketing/carexia.md to have a known_conflicts entry");
  const conflictText = carexiaMeta.known_conflicts.join(" ").toLowerCase();
  assert.match(conflictText, /135\s*kg/);
  assert.match(conflictText, /trendelenburg/);
  assert.match(conflictText, /reclined/);
  assert.match(conflictText, /regulatory/);

  const carexiaContent = KNOWLEDGE_FILES.get("marketing/carexia.md");
  assert.match(carexiaContent, /NEEDS CONFIRMATION/);
  // The old, since-fixed wording asserted a single settled interpretation —
  // guard against that regressing back in.
  assert.doesNotMatch(carexiaContent, /135kg \(in trendelenburg position\)\*\*\s*$/im);
});

test("AlbacMat's conflicting safe-working-load figures (470kg flyer vs 500kg manual) are both flagged, not averaged or silently picked", () => {
  const flyerMeta = sourcesMeta.sources["marketing/albacmat-flyer.md"];
  const manualMeta = sourcesMeta.sources["marketing/albacmat-manual-2019.md"];
  assert.ok(flyerMeta.known_conflicts.length > 0);
  assert.ok(manualMeta.known_conflicts.length > 0);

  const flyerContent = KNOWLEDGE_FILES.get("marketing/albacmat-flyer.md");
  const manualContent = KNOWLEDGE_FILES.get("marketing/albacmat-manual-2019.md");
  assert.match(flyerContent, /NEEDS CONFIRMATION/);
  assert.match(manualContent, /NEEDS CONFIRMATION/);
});

test("EasiMove SPU's ARTG number (528531) is confirmed, while PRO's assignment and 343300 stay flagged rather than assumed", () => {
  const artgMeta = sourcesMeta.sources["easimove-artg-and-regulatory.md"];
  assert.ok(artgMeta.known_conflicts.length > 0, "expected easimove-artg-and-regulatory.md to have a known_conflicts entry");
  const conflictText = artgMeta.known_conflicts.join(" ").toLowerCase();
  assert.match(conflictText, /528531/);
  assert.match(conflictText, /confirmed by jdhg/);
  assert.match(conflictText, /343300/);
  assert.match(conflictText, /not confirmed/);

  const artgContent = KNOWLEDGE_FILES.get("easimove-artg-and-regulatory.md");
  assert.match(artgContent, /NEEDS CONFIRMATION/);
  assert.match(artgContent, /Confirmed by JDHG \(2026-07-29\): 528531 is the ARTG number for EasiMove SPU/);
  assert.match(artgContent, /Not confirmed to apply to any current EasiMove product/);
});

test("EasiLift's marketing-only coverage and pre-launch roadmap status are flagged, not presented as confirmed availability", () => {
  const easiliftMeta = sourcesMeta.sources["marketing/easilift.md"];
  assert.equal(easiliftMeta.authority_level, "supported");
  assert.ok(easiliftMeta.known_conflicts.length > 0);
  const conflictText = easiliftMeta.known_conflicts.join(" ").toLowerCase();
  assert.match(conflictText, /no manufacturer ifu/);
  assert.match(conflictText, /confirm current commercial availability/);

  const easiliftContent = KNOWLEDGE_FILES.get("marketing/easilift.md");
  assert.match(easiliftContent, /NEEDS CONFIRMATION/);
});

test("the internal-use-only EasiMove competitor comparison is flagged as never customer-facing", () => {
  const compContent = KNOWLEDGE_FILES.get("competitive-positioning-easimove.md");
  assert.match(compContent, /INTERNAL USE ONLY/);
  assert.match(compContent, /must never be presented to a customer/i);
});

test("the system prompt instructs the model to never silently resolve a flagged source ambiguity", () => {
  assert.match(STATIC_INSTRUCTIONS, /needs_confirmation/);
  assert.match(STATIC_INSTRUCTIONS, /Do not resolve the ambiguity yourself/);
  assert.match(STATIC_INSTRUCTIONS, /Never silently pick one interpretation and present it as settled/);
});

test("the system prompt distinguishes marketing collateral from IFU/regulatory-grade evidence", () => {
  assert.match(STATIC_INSTRUCTIONS, /Marketing collateral[\s\S]*supports status supported at most/);
});

test("the system prompt tells the model never to generate a document link itself", () => {
  assert.match(STATIC_INSTRUCTIONS, /never type, construct, or guess a URL yourself/);
  assert.match(STATIC_INSTRUCTIONS, /linked below/);
});
