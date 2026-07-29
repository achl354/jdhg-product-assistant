// knowledgeStore.js
//
// Loads and routes the markdown knowledge base. The one rule that matters
// for cross-platform correctness: knowledge IDs (the strings used as map
// keys, in KNOWLEDGE_INDEX, and sent to the model as `filename="..."`) are
// ALWAYS built with a literal "/" via template strings, never with
// path.join/path.sep. path.join is only ever used to build actual filesystem
// paths for fs.readFileSync. This means the IDs are identical on Windows and
// Linux by construction — there is no OS branch to get wrong, so a single
// test suite run on any one platform is sufficient evidence for all of them.
import fs from "fs";
import path from "path";

// Always included regardless of routing — small citation/metadata file, not
// product content, so it costs almost nothing to keep in every request.
export const ALWAYS_INCLUDE = ["_sources.md"];

// Keyword -> knowledge ID routing. A file is included if ANY of its keywords
// appears in the search text (current message + recent history). Keep
// keyword lists generous (near-synonyms, model numbers, common misspellings)
// — over-including a file costs a little context, under-including risks a
// wrong "I don't have that."
//
// `file` here is a knowledge ID (forward-slash, e.g. "marketing/hygenica.md"),
// not a filesystem path — see loadAllKnowledgeFiles below.
export const KNOWLEDGE_INDEX = [
  {
    file: "artg-certificate.md",
    keywords: ["artg", "gmdn", "442032", "t-burg", "tburg", "trendelenburg", "sliding mattress"]
  },
  {
    file: "end-of-service-guidance.md",
    keywords: ["retire", "retirement", "end of service", "end-of-service", "wash cycle", "label integrity", "inspection", "reusable", "hovermatt", "hoverjack"]
  },
  {
    file: "product-range-and-faq.md",
    keywords: ["hovertech", "hovermatt", "hoverjack", "hoversling", "q2roller", "sitassist", "sit assist", "air supply", "mri", "latex", "breathab", "infection control", "flammab", "radiolucent"]
  },
  {
    file: "hovermatt-usage-and-ifu.md",
    keywords: ["hovermatt", "spu", "split-leg", "split leg", "half-matt", "half matt", "lateral transfer", "operating room", "or table", "hovercover"]
  },
  {
    file: "hoverjack-usage-and-ifu.md",
    keywords: ["hoverjack", "floor lift", "patient lift", "fall", "fallen", "inflate", "deflate", "chamber"]
  },
  {
    file: "hoversling-usage-and-ifu.md",
    keywords: ["hoversling", "sling", "hanger bar", "hoist", "seated transfer"]
  },
  {
    file: "air-supply-and-remaining-range-ifu.md",
    keywords: ["ht-air", "htair", "air supply", "2300", "q2roller", "roller", "t-burg", "tburg", "trendelenburg", "sitassist", "sit assist", "evac", "evacuation", "stairwell", "ems", "wedge"]
  },
  {
    file: "trenguard-artg-and-regulatory.md",
    keywords: ["trenguard", "275210", "290466", "290464", "d.a. surgical", "da surgical", "artg", "gmdn"]
  },
  {
    file: "trenguard-usage-and-ifu.md",
    keywords: ["trenguard", "speed bump", "rail clamp", "armguard", "faceguard", "shroudguard", "cervical", "trapezius", "lateral stabiliz", "support frame"]
  },
  {
    file: "competitive-positioning-hovermatt-trenguard.md",
    keywords: ["compet", "compar", "xodus", "pink pad", " vs ", "versus", "rebuttal"]
  },
  // --- Marketing collateral (JD Sales & Marketing Hub) — see knowledge/_sources.md
  // and knowledge/sources.meta.json for the trust-tier metadata on all of these.
  {
    file: "marketing/netzero.md",
    keywords: ["netzero", "net zero", "bioplastic", "sustainable underpad", "eco-friendly curtain", "recycled curtain"]
  },
  {
    file: "marketing/hygenica.md",
    keywords: ["hygenica", "fantex", "ipc curtain", "disposable blind", "hospital blind", "roller blind"]
  },
  {
    file: "marketing/medsalv.md",
    keywords: ["medsalv", "remanufactur", "blended code", "easimove spu", "collection point"]
  },
  {
    file: "marketing/minimaxx.md",
    keywords: ["minimaxx", "mini maxx", "xxl-rehab", "bariatric wheelchair", "push assist"]
  },
  {
    file: "marketing/albacmat-flyer.md",
    keywords: ["albacmat", "albac mat", "rescue mat", "evacuation mat", "fire evacuation"]
  },
  {
    file: "marketing/albacmat-manual-2019.md",
    keywords: ["albacmat", "albac mat", "rescue mat manual", "albacmat manual", "albacmat stairs", "albacmat training"]
  },
  {
    file: "marketing/carexia.md",
    keywords: ["carexia", "fpve", "treatment chair", "dialysis chair", "oncology chair"]
  },
  {
    // Deliberately no bare "imove" keyword: "EasiMove" always contains
    // "imove" as a substring (eas-IMOVE-pro), so a plain-substring match on
    // "imove" alone would wrongly pull this unrelated file into every
    // EasiMove question. "i-move" (the official hyphenated branding) plus
    // the other distinctive keywords below still catch real iMove questions.
    file: "marketing/imove.md",
    keywords: ["i-move", "ez-go", "ezgo", "stackable transfer chair", "easyclip", "easyclean", "softsound"]
  },
  {
    file: "marketing/trulife-pressurecare.md",
    keywords: ["trulife", "azure", "oasis", "pressurecare", "gel pad", "armboard pad", "head ring", "chest roll", "sacral protector", "ards prone", "positioner"]
  },
  {
    file: "marketing/raizer.md",
    keywords: ["raizer", "liftup", "lifting chair", "fallen person", "floor lift chair"]
  },
  {
    file: "marketing/amigo-pem.md",
    keywords: ["amigo", "patient escort mover", "pem"]
  },
  {
    file: "marketing/clavia.md",
    keywords: ["clavia", "fcd", "amb7", "chemo chair", "day surgery stretcher", "lsa surgery"]
  },
  {
    file: "marketing/easi-rider-mover.md",
    keywords: ["easi rider", "easi mover", "trolley tug", "bin mover", "tow hitch"]
  },
  // --- DMG (DirectMed Group) EasiSystem range — see knowledge/sources.meta.json
  // for trust-tier metadata. EasiMove PRO/SPU and EasiAir have real manufacturer
  // IFUs (+ ARTG for EasiMove); EasiLift currently has marketing material only.
  {
    file: "easimove-pro-usage-and-ifu.md",
    keywords: ["easimove pro", "easimove", "em34pro", "em39pro", "mhdm-em34pro", "mhdm-em39pro"]
  },
  {
    file: "easimove-spu-usage-and-ifu.md",
    keywords: ["easimove spu", "easimove", "em34spu", "em39spu", "em50spu", "split-leg", "split leg", "mhdm-em34spu", "mhdm-em39spu", "mhdm-em50spu"]
  },
  {
    file: "easiair-usage-and-ifu.md",
    keywords: ["easiair", "easi air", "variable speed air supply", "mhdm-emair"]
  },
  {
    file: "easimove-artg-and-regulatory.md",
    keywords: ["easimove artg", "343300", "528531", "easimove regulatory", "easimove gmdn"]
  },
  {
    file: "easimove-validation-summary.md",
    keywords: ["easimove validation", "easimove test", "easimove pull force", "easimove tensile", "jdhg-val-em"]
  },
  {
    file: "marketing/easimove.md",
    keywords: ["easimove recycled", "easimove sustainability", "easimove pla", "easimove packaging", "easimove flyer"]
  },
  {
    file: "marketing/easilift.md",
    keywords: ["easilift", "easi lift", "mhdm-el32", "mhdm-el39", "air patient lift"]
  },
  {
    file: "competitive-positioning-easimove.md",
    keywords: ["easimove competitor", "easimove comparison", "easimove rebuttal", "ht-branded", "hm-branded", "lm-branded"]
  }
];

// Walks knowledgeDir one level deep so subfolders (e.g. marketing/) are
// picked up as `<subfolder>/<file>.md` IDs, alongside top-level files.
// IDs are built with literal "/" (never path.join) so they are identical on
// every OS; only the absPath used for the actual file read is OS-native.
export function loadAllKnowledgeFiles(knowledgeDir) {
  const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      items.push({ id: entry.name, absPath: path.join(knowledgeDir, entry.name) });
    } else if (entry.isDirectory()) {
      const subDirAbs = path.join(knowledgeDir, entry.name);
      const subFiles = fs.readdirSync(subDirAbs).filter((f) => f.endsWith(".md"));
      for (const f of subFiles) {
        items.push({ id: `${entry.name}/${f}`, absPath: path.join(subDirAbs, f) });
      }
    }
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  const map = new Map();
  for (const item of items) {
    map.set(item.id, fs.readFileSync(item.absPath, "utf-8"));
  }
  return map;
}

// Returns the list of KNOWLEDGE_INDEX/ALWAYS_INCLUDE IDs that aren't actually
// present in the loaded knowledge map — empty array means everything is
// consistent. Pure/no side effects so it's easy to unit test; the caller
// (server.js) decides what to do with a non-empty result (fail startup).
export function findMissingKnowledgeFiles(knowledgeFilesMap, index = KNOWLEDGE_INDEX, alwaysInclude = ALWAYS_INCLUDE) {
  const missing = [];
  for (const entry of index) {
    if (!knowledgeFilesMap.has(entry.file)) missing.push(entry.file);
  }
  for (const f of alwaysInclude) {
    if (!knowledgeFilesMap.has(f)) missing.push(f);
  }
  return [...new Set(missing)];
}

// Combines the current message with the last few turns of history so a
// follow-up like "what about its cleaning instructions" still pulls in the
// right file even without repeating the product name.
export function buildSearchText(message, history = [], historyTurnsToConsider = 4) {
  const recentHistoryText = history
    .slice(-historyTurnsToConsider)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
  return `${recentHistoryText} ${message}`;
}

export function selectRelevantFiles(searchText, knowledgeFilesMap, index = KNOWLEDGE_INDEX, alwaysInclude = ALWAYS_INCLUDE) {
  const text = searchText.toLowerCase();
  const matched = new Set(alwaysInclude);

  for (const { file, keywords } of index) {
    if (keywords.some((kw) => text.includes(kw))) {
      matched.add(file);
    }
  }

  // Nothing matched beyond the always-included file — safer to send
  // everything than to risk a false "not in my knowledge base."
  if (matched.size <= alwaysInclude.length) {
    return [...knowledgeFilesMap.keys()];
  }

  return [...matched].filter((f) => knowledgeFilesMap.has(f));
}

export function buildKnowledgeBlock(filenames, knowledgeFilesMap) {
  return filenames
    .map((f) => `<document filename="${f}">\n${knowledgeFilesMap.get(f)}\n</document>`)
    .join("\n\n");
}
