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
  // external-use clearance, or stable document-control link was available
  // for any source at ingestion time, so these fields must stay
  // needs_confirmation everywhere rather than being guessed at.
  for (const [id, entry] of Object.entries(sourcesMeta.sources)) {
    for (const field of ["approval_status", "approver_owner", "external_use_permission", "secure_document_link"]) {
      assert.equal(entry[field], "needs_confirmation", `expected ${id}.${field} to be "needs_confirmation", got "${entry[field]}"`);
    }
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

test("the system prompt instructs the model to never silently resolve a flagged source ambiguity", () => {
  assert.match(STATIC_INSTRUCTIONS, /needs_confirmation/);
  assert.match(STATIC_INSTRUCTIONS, /Do not resolve the ambiguity yourself/);
  assert.match(STATIC_INSTRUCTIONS, /Never silently pick one interpretation and present it as settled/);
});

test("the system prompt distinguishes marketing collateral from IFU/regulatory-grade evidence", () => {
  assert.match(STATIC_INSTRUCTIONS, /Marketing collateral[\s\S]*supports status supported at most/);
});
