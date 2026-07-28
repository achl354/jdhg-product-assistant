// server.js
//
// Pilot HoverTech + TrenGuard product Q&A bot for JDHG reps.
//
// Deliberately simple: no live SharePoint search, no Teams/Bot Framework
// dependency. The entire knowledge base is a small set of manually curated
// markdown files (knowledge/*.md) exported once from vetted current
// documents. This sidesteps the Azure AD app registration + admin consent
// that live SharePoint access would require, at the cost of needing a
// manual re-export when a source document changes.
//
// Cost control: rather than sending every knowledge file on every request,
// a keyword router picks only the files relevant to the question (plus the
// last couple of turns, so follow-ups keep context). This is plain string
// matching, not embeddings/RAG — appropriate for a knowledge base this size.
// A question that matches nothing falls back to the full set rather than
// risking a false "not in my knowledge base."
import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const PORT = process.env.PORT || 3000;
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;

// Always included regardless of routing — small citation/metadata file, not
// product content, so it costs almost nothing to keep in every request.
const ALWAYS_INCLUDE = ["_sources.md"];

// Keyword -> filename routing. A file is included if ANY of its keywords
// appears in the search text (current message + recent history). Keep
// keyword lists generous (near-synonyms, model numbers, common misspellings)
// — over-including a file costs a little context, under-including risks a
// wrong "I don't have that."
const KNOWLEDGE_INDEX = [
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
  // for the "marketing collateral, not IFU/regulatory" caveat on all of these.
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
    file: "marketing/albacmat.md",
    keywords: ["albacmat", "albac mat", "rescue mat", "evacuation mat", "fire evacuation"]
  },
  {
    file: "marketing/carexia.md",
    keywords: ["carexia", "fpve", "treatment chair", "dialysis chair", "oncology chair"]
  },
  {
    file: "marketing/imove.md",
    keywords: ["i-move", "imove", "ez-go", "ezgo", "stackable transfer chair", "easyclip", "easyclean", "softsound"]
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
  }
];

// Walks knowledge/ one level deep so subfolders (e.g. marketing/) are picked
// up as `<subfolder>/<file>.md` keys, alongside top-level files.
function loadAllKnowledgeFiles() {
  const entries = fs.readdirSync(KNOWLEDGE_DIR, { withFileTypes: true });
  const relativePaths = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      relativePaths.push(entry.name);
    } else if (entry.isDirectory()) {
      const subFiles = fs
        .readdirSync(path.join(KNOWLEDGE_DIR, entry.name))
        .filter((f) => f.endsWith(".md"));
      for (const f of subFiles) {
        relativePaths.push(path.join(entry.name, f));
      }
    }
  }

  relativePaths.sort();
  const map = new Map();
  for (const rel of relativePaths) {
    map.set(rel, fs.readFileSync(path.join(KNOWLEDGE_DIR, rel), "utf-8"));
  }
  return map;
}

const KNOWLEDGE_FILES = loadAllKnowledgeFiles();
const ALL_FILENAMES = [...KNOWLEDGE_FILES.keys()];

function selectRelevantFiles(searchText) {
  const text = searchText.toLowerCase();
  const matched = new Set(ALWAYS_INCLUDE);

  for (const { file, keywords } of KNOWLEDGE_INDEX) {
    if (keywords.some((kw) => text.includes(kw))) {
      matched.add(file);
    }
  }

  // Nothing matched beyond the always-included file — safer to send
  // everything than to risk a false "not in my knowledge base."
  if (matched.size <= ALWAYS_INCLUDE.length) {
    return ALL_FILENAMES;
  }

  return [...matched].filter((f) => KNOWLEDGE_FILES.has(f));
}

function buildKnowledgeBlock(filenames) {
  return filenames
    .map((f) => `<document filename="${f}">\n${KNOWLEDGE_FILES.get(f)}\n</document>`)
    .join("\n\n");
}

// Gate the whole app behind a single shared username/password when both are
// configured (always set these when deploying anywhere reachable off your
// own machine). Left unset, the app runs open — convenient for local dev,
// but deliberately requires an explicit env var choice for anything public.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return next();

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (timingSafeEqual(user || "", BASIC_AUTH_USER) && timingSafeEqual(pass || "", BASIC_AUTH_PASS)) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="JDHG Product Assistant"');
  res.status(401).send("Authentication required.");
}

// Static instructions — never change per request, so this block caches
// across every request regardless of which knowledge files get routed in.
const STATIC_INSTRUCTIONS = `You are the JD Healthcare Group Product Assistant, used by sales reps in the field.

You may answer ONLY using the information in the <document> blocks provided in this conversation. Knowledge base coverage is uneven across JDHG's range: HoverTech (HoverMatt, HoverJack, HoverSling, Q2Roller, SitAssist Pro, HT-Air supply) and TrenGuard (Trendelenburg patient restraint system, plus ArmGuard/FaceGuard/ShroudGuard accessories) have full manufacturer IFU/usage manuals and ARTG/regulatory certificates loaded. Other product lines — currently NetZero, Hygenica, Medsalv, MiniMaxx, AlbacMat, Carexia, I-MOVE, Trulife Pressurecare, Raizer, AMIGO PEM, Clavia, and Easi Rider/Mover — currently have only JDHG marketing collateral (flyers, booklets, fact sheets) loaded, not manufacturer IFUs or ARTG certificates, unless a document explicitly says otherwise. IFU/manual-grade documentation for these other lines may be added later; when it is, treat it with the same full grounding as HoverTech/TrenGuard.

A keyword router selects which knowledge documents are attached to each message based on what it appears to be about — you will not always receive every document that exists. If a question seems to need a document that wasn't attached, say you don't have that information rather than guessing; don't assume something is out of scope just because its document isn't present this turn.

Rules:
1. Ground every factual claim (specs, ARTG/GMDN numbers, weight limits, cleaning instructions, retirement criteria, etc.) in the provided documents. If asked something the documents don't cover, say plainly that it's not in your current knowledge base and suggest the rep contact JD Healthcare Group directly (sales@jdhealthcare.com.au, 1300 791 404) or check with a product specialist — do not guess or infer from general knowledge, especially for anything ARTG/regulatory/compliance/safety-related.
2. When you answer, briefly note which document the answer came from (e.g. "per the End-of-Service Guidance..." or "per JDHG's TrenGuard User Guide...") so the rep knows the source.
3. **Trust tier by document type, not by product line.** Each knowledge file states its own content type near the top (or in knowledge/_sources.md) — manufacturer IFU/user manual, ARTG/regulatory certificate, internal operational guidance, or marketing/sales collateral. Manufacturer IFUs, user manuals, and ARTG certificates carry full clinical/regulatory grounding. Marketing collateral (flyers, booklets, fact sheets, sales positioning material) should be presented as such — e.g. "per JDHG's [Product] flyer..." rather than implying IFU-level clinical/regulatory authority — and any figure or claim marked in the source as a reported/manufacturer/distributor claim (a sustainability statistic, a usage-count claim, a competitor comparison) should be flagged as unverified rather than stated as settled fact. If a knowledge file flags an internal inconsistency (e.g. two source documents disagreeing on a safe working load or product code), surface that discrepancy to the rep and suggest confirming with JDHG/Regulatory rather than picking one figure silently.
4. This knowledge base deliberately excludes large legacy archives of older supplier material for HoverTech and TrenGuard (2011-2024 for HoverTech, 2015-2021 for TrenGuard, including outdated competitor comparisons and hospital-specific evaluation forms). If a question seems like it needs that older material, say so rather than pretending you have it.
5. For TrenGuard specifically: the current JDHG User Guide (2024) overrides the older 2015 D.A. Surgical manufacturer IFU wherever they disagree (e.g. reverse Trendelenburg use, warranty period) — always answer per the current JDHG guide, and mention the older document only if directly relevant.
6. Keep answers concise and practical — reps are often asking mid-conversation with a customer.
7. Never state something is TGA/ARTG-approved or compliant unless the documents explicitly say so.`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(basicAuth);
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }

  // Route on the current message plus the last couple of turns, so a
  // follow-up like "what about its cleaning instructions" still pulls in
  // the right file even without repeating the product name.
  const recentHistoryText = history
    .slice(-4)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
  const selectedFiles = selectRelevantFiles(`${recentHistoryText} ${message}`);
  const knowledgeBlock = buildKnowledgeBlock(selectedFiles);

  console.log(`[chat] routed to: ${selectedFiles.join(", ")}`);

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: STATIC_INSTRUCTIONS,
          cache_control: { type: "ephemeral" }
        },
        {
          type: "text",
          text: `<knowledge_base>\n${knowledgeBlock}\n</knowledge_base>`,
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: [...history, { role: "user", content: message }]
    });

    const textBlock = response.content.find((b) => b.type === "text");
    res.json({ reply: textBlock ? textBlock.text : "" });
  } catch (err) {
    console.error("Chat request failed:", err.message);
    res.status(502).json({ error: "Failed to reach the assistant. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`JDHG Product Q&A bot listening on http://localhost:${PORT}`);
  console.log(`Knowledge base: ${ALL_FILENAMES.length} files in ${KNOWLEDGE_DIR}`);
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) {
    console.warn("WARNING: BASIC_AUTH_USER/BASIC_AUTH_PASS not set — running with no access control.");
  }
});
