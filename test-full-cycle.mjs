/**
 * Full pipeline cycle test — run with:  node test-full-cycle.mjs
 *
 * Runs the COMPLETE automation pipeline end-to-end against a real source:
 *
 *  Source (experience-oberlin)
 *     ↓
 *  Agent 1: Listing Collector  — browser MCP → event URLs
 *     ↓
 *  Agent 2: Detail Extractor   — browser MCP → structured event data
 *     ↓
 *  Agent 3: Hyperlocal Tagger  — OpenAI text → scope + geographic_tags
 *     ↓
 *  Agent 4: Dedup Agent        — OpenAI text → is_duplicate flag
 *     ↓
 *  SQLite staging table        — events_staging rows with all fields
 *
 * Verifies every stage produced real data, then prints a full event card.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Load .env ─────────────────────────────────────────────────────────────────
const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dir, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

// Override: use a fresh throwaway DB so the test never touches production data
const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "oberlin-cycle-test-"));
const tmpDb   = path.join(tmpDir, "test.db");
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH  = tmpDb;
// Disable background poller — we call processSource manually
process.env.POLLER_ENABLED = "false";
// Cap detail extractions to 2 so the test finishes in under 2 minutes
process.env.DETAIL_EXTRACTION_LIMIT = "2";
// Enable dedup so all 4 agents run
process.env.OPENAI_DEDUPE_ENABLED = "true";

// ── Colour helpers ────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", B = "\x1b[1m", X = "\x1b[0m";
const PASS = `${G}${B}PASS${X}`, FAIL = `${R}${B}FAIL${X}`, INFO = `${C}${B}INFO${X}`;

let passed = 0, failed = 0;
function ok(msg)       { passed++; console.log(`  ${PASS}  ${msg}`); }
function fail(msg, e)  { failed++; console.log(`  ${FAIL}  ${msg}${e ? "\n         " + R + (e.message || e) + X : ""}`); }
function info(msg)     { console.log(`  ${INFO}  ${msg}`); }
function section(name) { console.log(`\n${C}${B}─── ${name} ${"─".repeat(Math.max(0,55-name.length))}${X}`); }

function assert(cond, label, detail = "") {
  if (cond) ok(label);
  else fail(label + (detail ? " — " + detail : ""));
}

// ── Checks ────────────────────────────────────────────────────────────────────
const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
const hasMcp    = !!(process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();

console.log(`${B}Oberlin Calendar — Full Pipeline Cycle Test${X}`);
console.log(`════════════════════════════════════════════════════════`);
console.log(`  DB        : ${tmpDb}`);
console.log(`  OpenAI    : ${hasOpenAI ? G+"present"+X : R+"MISSING"+X}`);
console.log(`  MCP URL   : ${hasMcp ? G+(process.env.MCP_BROWSER_URL||process.env.PLAYWRIGHT_MCP_URL)+X : R+"MISSING — set MCP_BROWSER_URL"+X}`);

if (!hasOpenAI || !hasMcp) {
  console.log(`\n${R}Cannot run full cycle without both OPENAI_API_KEY and MCP_BROWSER_URL.${X}`);
  process.exit(1);
}

// ── Bootstrap service ─────────────────────────────────────────────────────────
const { createRepository } = await import("./src/automation/db.js");
const { createAutomationService } = await import("./src/automation/service.js");

const runtimeConfig = {
  dataDir: tmpDir,
  dbPath: tmpDb,
  pollerEnabled: false,
  pollerIntervalMs: 60_000,
  autoSeedSources: false,
  seedSourcesPath: path.join(__dir, "data/sources.example.json"),
  requestTimeoutMs: 30_000,
  openaiDedupeEnabled: true,
  openaiDedupeModel: process.env.OPENAI_DEDUPE_MODEL || "gpt-4.1-mini",
  openaiDedupeContextLimit: 10,
  openaiDedupeMinConfidence: 0.75,
  detailExtractionDelayMs: 500,   // fast for testing
  communityHubCalendarUrl:
    process.env.COMMUNITY_HUB_CALENDAR_URL ||
    "https://environmentaldashboard.org/calendar/?show-menu-bar=1",
  communityHubSnapshotMaxEvents: 50,
  communityHubSnapshotModel: process.env.COMMUNITY_HUB_SNAPSHOT_MODEL || "gpt-4.1-mini"
};

const repository = createRepository(runtimeConfig);
const service    = createAutomationService(repository, runtimeConfig);

// ── Seed the test source ──────────────────────────────────────────────────────
section("Setup — seed source");

const testSource = {
  source_id: "experience-oberlin",
  source_name: "Experience Oberlin",
  source_domain: "experienceoberlin.com",
  source_type: "browser",
  listing_url: "https://experienceoberlin.com/events",
  adapter_key: "openai_listing_v1",
  poll_interval_minutes: 720,
  is_active: true,
  adapter_config: {
    max_links: 5,                   // collect up to 5 links
    max_detail_extractions: 2,      // extract details for up to 2 events
    extract_event_details: true,
    allowed_hosts: ["experienceoberlin.com", "www.experienceoberlin.com"]
  }
};

const src = repository.createSource(testSource);
assert(!!src?.id, "source created in DB");
info(`source id = ${src.id}`);

// ── Run the full pipeline ─────────────────────────────────────────────────────
section("Running full pipeline (Agents 1 → 2 → 3 → 4)");
console.log(`  ${Y}This will take 60–120 seconds — all 4 agents running in sequence…${X}\n`);

const startMs = Date.now();
let pipelineResult;

try {
  pipelineResult = await service.processSource("experience-oberlin");
} catch (e) {
  fail("processSource threw an error", e);
  console.log(`\n${R}Pipeline crashed — cannot continue.${X}`);
  process.exit(1);
}

const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
info(`pipeline finished in ${elapsedSec}s`);

// ── Stage 1: pipeline return value ───────────────────────────────────────────
section("Stage 1 — pipeline return value");
console.log(`  result: ${JSON.stringify(pipelineResult)}`);
assert(pipelineResult.status === "success", `status is "success" (got: ${pipelineResult.status})`);
assert(typeof pipelineResult.new_candidates === "number", `new_candidates is a number (got: ${pipelineResult.new_candidates})`);
assert(pipelineResult.new_candidates > 0, `new_candidates > 0 (got: ${pipelineResult.new_candidates})`);

// ── Stage 2: event candidates in DB ──────────────────────────────────────────
section("Stage 2 — event_candidates table (Agent 1 output)");
const candidates = repository.listCandidates({ sourceId: "experience-oberlin", limit: 50 });
info(`candidates in DB: ${candidates.length}`);
assert(candidates.length > 0, "at least 1 candidate saved to DB");
if (candidates.length > 0) {
  const c = candidates[0];
  assert(typeof c.event_url === "string" && c.event_url.startsWith("http"),
    `candidate[0].event_url is a URL (got: ${c.event_url})`);
  assert(typeof c.fingerprint === "string" && c.fingerprint.length === 64,
    `candidate[0].fingerprint is a sha256 hex string`);
  info(`sample: "${c.title_hint}" → ${c.event_url}`);
}

// ── Stage 3: staged events in DB ─────────────────────────────────────────────
section("Stage 3 — events_staging table (Agents 2–4 output)");
const staged = repository.listStaging({ sourceId: "experience-oberlin", limit: 50 });
info(`staged events in DB: ${staged.length}`);
assert(staged.length > 0, "at least 1 event staged");

if (staged.length > 0) {
  // ── Agent 2 checks: extracted fields ───────────────────────────────────────
  section("Agent 2 — Detail Extractor output");
  const ev = staged[0];
  info(`event[0]: "${ev.title}"`);
  assert(typeof ev.title === "string" && ev.title.length > 0,
    `title is a non-empty string (got: "${ev.title}")`);
  assert(typeof ev.source_event_url === "string" && ev.source_event_url.startsWith("http"),
    `source_event_url is a URL (got: ${ev.source_event_url})`);
  assert(ev.community_hub_payload && typeof ev.community_hub_payload === "object",
    "community_hub_payload object is present");
  assert(typeof ev.community_hub_payload.title === "string",
    `payload.title is a string (got: "${ev.community_hub_payload.title}")`);
  assert(ev.review_status === "pending",
    `review_status defaults to "pending" (got: "${ev.review_status}")`);

  // ── Agent 3 checks: hyperlocal tagging ─────────────────────────────────────
  section("Agent 3 — Hyperlocal Tagger output");
  const validScopes = ["hyperlocal","city","lorain_county","northeast_ohio","state","national","online","unknown"];
  const hasScope = validScopes.includes(ev.hyperlocal_scope);
  info(`hyperlocal_scope = "${ev.hyperlocal_scope}"`);
  info(`geographic_tags  = ${JSON.stringify(ev.geographic_tags)}`);
  assert(hasScope,
    `hyperlocal_scope is a valid scope value (got: "${ev.hyperlocal_scope}")`);
  assert(Array.isArray(ev.geographic_tags),
    "geographic_tags is an array");

  // ── Agent 4 checks: dedup ──────────────────────────────────────────────────
  section("Agent 4 — Dedup Agent output");
  info(`is_duplicate     = ${ev.is_duplicate}`);
  info(`duplicate_reason = ${ev.duplicate_reason || "(none)"}`);
  assert(ev.is_duplicate !== undefined && ev.is_duplicate !== null,
    `is_duplicate field was set (got: ${ev.is_duplicate})`);
  // An event from a fresh DB should NOT be a duplicate
  assert(ev.is_duplicate === false,
    `first event in fresh DB is not a duplicate (got: ${ev.is_duplicate})`);

  // ── Source run record ──────────────────────────────────────────────────────
  section("Source run record");
  const runs = repository.listRuns({ sourceId: "experience-oberlin", limit: 5 });
  assert(runs.length > 0, "at least 1 run record in DB");
  if (runs.length > 0) {
    const run = runs[0];
    info(`run status = "${run.status}"  candidates = ${run.new_candidates}  staged = ${run.upserted_events}`);
    assert(run.status === "success", `run.status is "success" (got: "${run.status}")`);
    assert(typeof run.finished_at === "string", "run has a finished_at timestamp");
  }

  // ── Source last-run fields updated ────────────────────────────────────────
  const updatedSrc = repository.getSource("experience-oberlin");
  assert(updatedSrc.last_run_status === "success",
    `source.last_run_status updated to "success" (got: "${updatedSrc.last_run_status}")`);
  assert(typeof updatedSrc.last_polled_at === "string",
    "source.last_polled_at was stamped");
  assert(typeof updatedSrc.next_run_at === "string",
    "source.next_run_at was scheduled");

  // ── Print full event card ──────────────────────────────────────────────────
  section("Full staged event (human-readable)");
  const p = ev.community_hub_payload;
  const pad = (l, v) => console.log(`  ${C}${l.padEnd(32)}${X}${v || "(null)"}`);
  pad("Title",              ev.title);
  pad("Start",              ev.start_datetime);
  pad("End",                ev.end_datetime);
  pad("Location Type",      ev.location_type);
  pad("Location",           ev.location_or_address);
  pad("Sponsor",            ev.organizational_sponsor);
  pad("Scope",              ev.hyperlocal_scope);
  pad("Geo Tags",           (ev.geographic_tags||[]).join(", "));
  pad("Is Duplicate",       String(ev.is_duplicate));
  pad("Review Status",      ev.review_status);
  pad("Source URL",         ev.source_event_url);
  pad("Short Description",  (ev.short_description||"").slice(0,80)+(ev.short_description?.length>80?"…":""));
  pad("Categories",         (p?.event_type_categories||[]).join(", "));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(57)}`);
const total = passed + failed;
console.log(`${B}Results: ${G}${passed} passed${X}  ${R}${failed} failed${X}  (${total} assertions)`);
if (failed === 0) {
  console.log(`${G}${B}Full pipeline cycle test PASSED ✓${X}`);
} else {
  console.log(`${R}${B}Cycle test FAILED — ${failed} assertion(s) broken.${X}`);
}

// Cleanup temp DB
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
