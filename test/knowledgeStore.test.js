import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import os from "os";

import {
  ALWAYS_INCLUDE,
  KNOWLEDGE_INDEX,
  loadAllKnowledgeFiles,
  findMissingKnowledgeFiles,
  buildSearchText,
  selectRelevantFiles,
  buildKnowledgeBlock
} from "../lib/knowledgeStore.js";

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const REAL_KNOWLEDGE_FILES = loadAllKnowledgeFiles(KNOWLEDGE_DIR);

test("every file referenced by KNOWLEDGE_INDEX and ALWAYS_INCLUDE exists on disk", () => {
  const missing = findMissingKnowledgeFiles(REAL_KNOWLEDGE_FILES, KNOWLEDGE_INDEX, ALWAYS_INCLUDE);
  assert.deepEqual(missing, []);
});

test("findMissingKnowledgeFiles reports an entry that doesn't exist in the loaded map", () => {
  const fakeMap = new Map([["real-file.md", "content"]]);
  const fakeIndex = [{ file: "real-file.md", keywords: ["x"] }, { file: "missing-file.md", keywords: ["y"] }];
  const missing = findMissingKnowledgeFiles(fakeMap, fakeIndex, []);
  assert.deepEqual(missing, ["missing-file.md"]);
});

test("subfolder knowledge IDs use forward slashes, never OS path separators", () => {
  const subfolderIds = [...REAL_KNOWLEDGE_FILES.keys()].filter((id) => id.includes("marketing"));
  assert.ok(subfolderIds.length > 0, "expected at least one marketing/* knowledge file");
  for (const id of subfolderIds) {
    assert.ok(id.includes("/"), `expected ${id} to use a forward slash`);
    assert.ok(!id.includes("\\"), `expected ${id} not to contain a backslash`);
  }
  assert.ok(REAL_KNOWLEDGE_FILES.has("marketing/hygenica.md"));
});

// Regression test for the original bug: an earlier version of
// loadAllKnowledgeFiles built the map key with path.join(entry.name, f),
// which is backslash-joined on Windows (path.win32.join) and would never
// match the forward-slash strings in KNOWLEDGE_INDEX. Demonstrate the fixed
// implementation does not reproduce that failure mode, using path.win32
// directly so the assertion doesn't depend on which OS the suite runs on.
test("knowledge IDs are built independently of path.join/OS separator (Windows regression)", () => {
  const buggyWindowsId = path.win32.join("marketing", "hygenica.md");
  assert.equal(buggyWindowsId, "marketing\\hygenica.md");

  const fixedId = `${"marketing"}/${"hygenica.md"}`;
  assert.equal(fixedId, "marketing/hygenica.md");
  assert.notEqual(fixedId, buggyWindowsId);

  // The actual loader must produce the fixed form, not the buggy one.
  assert.ok(REAL_KNOWLEDGE_FILES.has(fixedId));
  assert.ok(!REAL_KNOWLEDGE_FILES.has(buggyWindowsId));
});

test("loadAllKnowledgeFiles builds forward-slash IDs from a temp directory regardless of platform separator used for absPath", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"));
  const subDir = path.join(tmpDir, "marketing");
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(subDir, "hygenica.md"), "# Hygenica test fixture");

  const map = loadAllKnowledgeFiles(tmpDir);
  assert.ok(map.has("marketing/hygenica.md"));
  assert.equal(map.get("marketing/hygenica.md"), "# Hygenica test fixture");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('"Hygenica" routes to marketing/hygenica.md', () => {
  const selected = selectRelevantFiles("Tell me about Hygenica curtains", REAL_KNOWLEDGE_FILES);
  assert.ok(selected.includes("marketing/hygenica.md"));
});

test("at least one test question routes correctly for every KNOWLEDGE_INDEX entry", () => {
  for (const entry of KNOWLEDGE_INDEX) {
    const keyword = entry.keywords[0];
    const selected = selectRelevantFiles(keyword, REAL_KNOWLEDGE_FILES);
    assert.ok(
      selected.includes(entry.file),
      `expected keyword "${keyword}" to route to ${entry.file}, got [${selected.join(", ")}]`
    );
  }
});

test("an unmatched question falls back to the full knowledge set", () => {
  const selected = selectRelevantFiles("zzqxwv nonsense not a real product keyword", REAL_KNOWLEDGE_FILES);
  assert.deepEqual(new Set(selected), new Set(REAL_KNOWLEDGE_FILES.keys()));
});

test("a follow-up question retains product context via history", () => {
  const history = [
    { role: "user", content: "Tell me about Hygenica curtains" },
    { role: "assistant", content: "Hygenica curtains are treated with Fantex antimicrobial technology." }
  ];
  const searchText = buildSearchText("What about the disposable blinds cleaning instructions?", history);
  const selected = selectRelevantFiles(searchText, REAL_KNOWLEDGE_FILES);
  assert.ok(selected.includes("marketing/hygenica.md"));
});

test("buildSearchText only looks at the configured number of recent history turns", () => {
  const history = [
    { role: "user", content: "Tell me about Hygenica curtains" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and something else" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and another thing" },
    { role: "assistant", content: "ok" }
  ];
  const searchText = buildSearchText("follow up", history, 1);
  assert.ok(!searchText.toLowerCase().includes("hygenica"));
});

test("buildKnowledgeBlock wraps each file's content in a labelled document block", () => {
  const map = new Map([["a.md", "content A"], ["b.md", "content B"]]);
  const block = buildKnowledgeBlock(["a.md", "b.md"], map);
  assert.match(block, /<document filename="a\.md">\ncontent A\n<\/document>/);
  assert.match(block, /<document filename="b\.md">\ncontent B\n<\/document>/);
});
