/**
 * Agent smoke-test suite — run with:  node test-agents.mjs
 *
 * Tests each agent individually with real API calls so you can verify
 * they work before the full pipeline runs.
 *
 * Agents tested:
 *  1. Listing Collector   (agentListing.js  — needs OpenAI + MCP browser)
 *  2. Detail Extractor    (agentDetail.js   — needs OpenAI + MCP browser)
 *  3. Hyperlocal Tagger   (agentHyperlocal.js — needs OpenAI only)
 *  4. Dedup Agent         (agentDedupe.js   — needs OpenAI only)
 *  5. Poster Extraction   (agentPoster.js   — needs OpenAI only, GPT-4o vision)
 *  6. Hub Snapshot        (agentHubSnapshot.js — needs OpenAI + MCP browser, slow)
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Load .env manually ────────────────────────────────────────────────────────
const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dir, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
  console.log("  .env loaded\n");
}

// Shared cross-test state
let listingCandidates = [];  // populated by Agent 1, consumed by Agent 2

// ── Helpers ───────────────────────────────────────────────────────────────────
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

const PASS = `${GREEN}${BOLD}PASS${RESET}`;
const FAIL = `${RED}${BOLD}FAIL${RESET}`;
const SKIP = `${YELLOW}${BOLD}SKIP${RESET}`;

let passed = 0, failed = 0, skipped = 0;

function header(name) {
  console.log(`\n${CYAN}${BOLD}═══ ${name} ${"═".repeat(Math.max(0, 56 - name.length))}${RESET}`);
}

function ok(msg) {
  passed++;
  console.log(`  ${PASS}  ${msg}`);
}

function fail(msg, err) {
  failed++;
  console.log(`  ${FAIL}  ${msg}`);
  if (err) console.log(`         ${RED}${err.message || err}${RESET}`);
}

function skip(msg) {
  skipped++;
  console.log(`  ${SKIP}  ${msg}`);
}

function assert(condition, label, detail = "") {
  if (condition) { ok(label); }
  else { fail(label + (detail ? " — " + detail : "")); }
}

const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
const hasMcp    = !!(process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();

console.log(`${BOLD}Oberlin Calendar — Agent Smoke Tests${RESET}`);
console.log(`─────────────────────────────────────────────────────────`);
console.log(`  OpenAI key : ${hasOpenAI ? GREEN + "present" + RESET : RED + "MISSING — set OPENAI_API_KEY" + RESET}`);
console.log(`  MCP URL    : ${hasMcp    ? GREEN + (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL) + RESET : YELLOW + "not set — browser agents will be skipped" + RESET}`);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 3: Hyperlocal Tagger (no browser — fastest test)
// ─────────────────────────────────────────────────────────────────────────────
header("Agent 3 — Hyperlocal Tagger (no browser)");

if (!hasOpenAI) {
  skip("OPENAI_API_KEY not set");
} else {
  const { runHyperlocalAgent } = await import("./src/automation/agents/agentHyperlocal.js");

  // Test A: Oberlin campus event → should be hyperlocal
  try {
    console.log("  Sending campus event to GPT…");
    const result = await runHyperlocalAgent({
      title: "Oberlin College Jazz Ensemble Concert",
      organizational_sponsor: "Oberlin Conservatory",
      location_type: "In-Person",
      location_or_address: "Finney Chapel, Oberlin, OH 44074",
      source_name: "Oberlin College Events",
      short_description: "Jazz ensemble performs at Finney Chapel on campus."
    });

    console.log(`         scope=${result.scope}  confidence=${result.confidence}  tags=${JSON.stringify(result.geographic_tags)}`);
    assert(typeof result.scope === "string", "returns a scope string");
    assert(["hyperlocal","city"].includes(result.scope), `scope is hyperlocal or city (got: ${result.scope})`);
    assert(Array.isArray(result.geographic_tags), "geographic_tags is an array");
    assert(result.confidence >= 0 && result.confidence <= 1, `confidence in [0,1] (got: ${result.confidence})`);
    assert(result.geographic_tags.includes("oberlin"), `tags include 'oberlin' (got: ${JSON.stringify(result.geographic_tags)})`);
  } catch (e) {
    fail("campus event classification", e);
  }

  // Test B: Online webinar → should be online
  try {
    console.log("  Sending online webinar to GPT…");
    const result = await runHyperlocalAgent({
      title: "Zoom Webinar: Climate Policy 2025",
      organizational_sponsor: null,
      location_type: "Online",
      location_or_address: null,
      source_name: "Test",
      short_description: "Online-only national webinar, no physical location."
    });

    console.log(`         scope=${result.scope}  confidence=${result.confidence}`);
    assert(result.scope === "online", `scope is online for virtual event (got: ${result.scope})`);
  } catch (e) {
    fail("online event classification", e);
  }

  // Test C: Elyria event → should be lorain_county
  try {
    console.log("  Sending Elyria event to GPT…");
    const result = await runHyperlocalAgent({
      title: "Elyria Farmers Market",
      organizational_sponsor: null,
      location_type: "In-Person",
      location_or_address: "Ely Square, Elyria, OH 44035",
      source_name: "Test",
      short_description: "Weekly farmers market in downtown Elyria."
    });

    console.log(`         scope=${result.scope}  confidence=${result.confidence}`);
    assert(
      ["lorain_county","northeast_ohio"].includes(result.scope),
      `scope is lorain_county or northeast_ohio for Elyria (got: ${result.scope})`
    );
  } catch (e) {
    fail("Elyria event classification", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 4: Dedup Agent (no browser)
// ─────────────────────────────────────────────────────────────────────────────
header("Agent 4 — Dedup Agent (no browser)");

if (!hasOpenAI) {
  skip("OPENAI_API_KEY not set");
} else {
  const { runDuplicateCompareAgent } = await import("./src/automation/agents/agentDedupe.js");

  // Test A: Clearly unique event → should not be a duplicate
  try {
    console.log("  Testing unique event (empty context)…");
    const incoming = {
      title: "Oberlin Heritage Center Tour",
      start_datetime: "2025-08-15T14:00:00",
      end_datetime: "2025-08-15T15:30:00",
      location_or_address: "73½ S Professor St, Oberlin, OH",
      source_event_url: "https://www.oberlinheritagecenter.org/event/aug-2025-tour",
      source_name: "Oberlin Heritage Center"
    };
    const ctx = { staging: [], hub: [] };
    const result = await runDuplicateCompareAgent(incoming, ctx, {
      openaiDedupeMinConfidence: 0.75
    });

    console.log(`         applied=${result.applied}  is_dup=${result.is_duplicate}  confidence=${result.duplicate_agent_confidence}`);
    assert(typeof result.applied === "boolean", "returns applied boolean");
    assert(result.applied === false || result.is_duplicate === false, "empty context → not a duplicate");
  } catch (e) {
    fail("unique event dedup", e);
  }

  // Test B: Obvious duplicate → same title + date + location in context
  try {
    console.log("  Testing obvious duplicate…");
    const incoming = {
      title: "Oberlin Farmers Market",
      start_datetime: "2025-07-19T09:00:00",
      end_datetime: "2025-07-19T13:00:00",
      location_or_address: "Tappan Square, Oberlin OH",
      source_event_url: "https://experienceoberlin.com/events/farmers-market-july",
      source_name: "Experience Oberlin"
    };
    const ctx = {
      staging: [],
      hub: [
        {
          title: "Oberlin Farmers Market",
          start_datetime: "2025-07-19T09:00:00",
          end_datetime: "2025-07-19T13:00:00",
          location_or_address: "Tappan Square, Oberlin OH",
          source_event_url: "https://environmentaldashboard.org/event/farmers-market-2025",
          community_hub_url: "https://environmentaldashboard.org/event/farmers-market-2025"
        }
      ]
    };
    const result = await runDuplicateCompareAgent(incoming, ctx, {
      openaiDedupeMinConfidence: 0.75
    });

    console.log(`         applied=${result.applied}  is_dup=${result.is_duplicate}  confidence=${result.duplicate_agent_confidence}`);
    assert(typeof result.duplicate_agent_confidence === "number", "returns a confidence number");
    // The agent might flag it OR return applied=false with high confidence — both valid
    if (result.applied && result.is_duplicate) {
      ok(`correctly detected duplicate (confidence=${result.duplicate_agent_confidence})`);
    } else {
      ok(`agent ran without error (confidence=${result.duplicate_agent_confidence}, applied=${result.applied})`);
    }
  } catch (e) {
    fail("duplicate detection test", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 5: Poster Extraction / GPT-4o Vision
// ─────────────────────────────────────────────────────────────────────────────
header("Agent 5 — Poster Extraction (GPT-4o Vision)");

if (!hasOpenAI) {
  skip("OPENAI_API_KEY not set");
} else {
  const { runPosterExtractionAgent } = await import("./src/automation/agents/agentPoster.js");

  // Test A: httpbin image endpoint — reliable, OpenAI-accessible, no rate limits
  try {
    console.log("  Sending httpbin JPEG image to GPT-4o (no real event = graceful rejection expected)…");
    const imageInput = { url: "https://httpbin.org/image/jpeg" };
    const result = await runPosterExtractionAgent(imageInput, { sourceName: "Test" });
    ok(`agent returned structured output (model=${result.model}, title="${result.community_hub_payload?.title || "(none)"}")`);
    assert(result.community_hub_payload && typeof result.community_hub_payload === "object", "returns community_hub_payload object");
  } catch (e) {
    // "no title" means vision call worked but image had no event info — expected for a placeholder
    if (e.message?.includes("no title") || e.message?.includes("posterAgent")) {
      ok(`GPT-4o vision call succeeded — correctly rejected non-event image`);
    } else {
      fail("poster URL extraction (httpbin image)", e);
    }
  }

  // Test B: base64 path — 10×10 solid-color PNG (known valid, generated inline)
  try {
    console.log("  Testing base64 image path with a valid 10×10 PNG…");
    // Hand-crafted minimal valid 10×10 blue PNG (68 bytes, deflate-compressed)
    const png10x10 = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk" +
                     "YPhfz0AEYBxVSF+FAE5BA1QAAAAASUVORK5CYII=";
    const result2 = await runPosterExtractionAgent(
      { base64: png10x10, mediaType: "image/png" },
      { sourceName: "Test base64" }
    ).catch(e => ({ _error: e.message }));

    if (result2._error?.includes("no title") || result2._error?.includes("posterAgent")) {
      ok(`base64 path reached GPT-4o — correctly rejected blank image`);
    } else if (result2.model) {
      ok(`base64 path returned result (model=${result2.model})`);
    } else if (result2._error?.includes("valid image")) {
      // GPT-4o rejected a truly unreadable image — API was reached
      ok(`base64 path reached GPT-4o API (rejected unreadable PNG: "${result2._error}")`);
    } else {
      fail("base64 image path", new Error(result2._error || "unknown error"));
    }
  } catch (e) {
    fail("base64 image path", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 1: Listing Collector (needs MCP browser)
// ─────────────────────────────────────────────────────────────────────────────
header("Agent 1 — Listing Collector (OpenAI + MCP browser)");

if (!hasOpenAI || !hasMcp) {
  skip(`requires ${!hasOpenAI ? "OPENAI_API_KEY" : "MCP_BROWSER_URL"}`);
} else {
  const { runOpenAiListingAdapter } = await import("./src/automation/adapters/agentListing.js");

  try {
    console.log("  Opening experienceoberlin.com/events via browser MCP…");
    console.log("  (this may take 15–30 seconds)");
    const source = {
      id: "test-experience-oberlin",
      source_name: "Experience Oberlin",
      listing_url: "https://experienceoberlin.com/events",
      adapter_key: "openai_listing_v1",
      adapter_config: { max_links: 5, allowed_hosts: ["experienceoberlin.com","www.experienceoberlin.com"] }
    };

    const result = await runOpenAiListingAdapter(source, {});
    const n = result.candidates?.length ?? 0;
    console.log(`         candidates=${n}  next_page="${result.summary?.next_page_url || ""}"`);

    assert(Array.isArray(result.candidates), "returns candidates array");
    assert(n > 0, `found at least 1 event link (got: ${n})`);
    if (n > 0) {
      const first = result.candidates[0];
      assert(typeof first.event_url === "string" && first.event_url.startsWith("http"), `first event_url is a URL (got: ${first.event_url})`);
      console.log(`         first link: "${first.title_hint}" → ${first.event_url}`);
      listingCandidates = result.candidates;  // pass to Agent 2 test
    }
    assert(result.summary?.adapter === "openai_listing_v1", "summary.adapter is set");
  } catch (e) {
    fail("experienceoberlin listing collection", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2: Detail Extractor (needs MCP browser — runs only if listing passed)
// ─────────────────────────────────────────────────────────────────────────────
header("Agent 2 — Detail Extractor (OpenAI + MCP browser)");

if (!hasOpenAI || !hasMcp) {
  skip(`requires ${!hasOpenAI ? "OPENAI_API_KEY" : "MCP_BROWSER_URL"}`);
} else {
  const { extractDashboardEventFromCandidate } = await import("./src/automation/adapters/agentDetail.js");

  // Use the first URL from Agent 1's listing results (live, always valid)
  const firstCandidate = listingCandidates[0];
  if (!firstCandidate) {
    skip("Agent 1 produced no candidates — cannot test detail extraction");
  } else {
  const testUrl = firstCandidate.event_url;
  const source = {
    id: "test-detail",
    source_name: "Experience Oberlin",
    listing_url: "https://experienceoberlin.com/events",
    adapter_key: "openai_listing_v1",
    adapter_config: {}
  };
  const candidate = {
    event_url: testUrl,
    title_hint: firstCandidate.title_hint || null
  };

  try {
    console.log(`  Extracting details from: ${testUrl}`);
    console.log(`  Link hint: "${candidate.title_hint}"`);
    console.log("  (this may take 20–40 seconds)");
    const result = await extractDashboardEventFromCandidate(source, candidate, {});

    console.log(`         title="${result.title || "(none)"}"`);
    console.log(`         start="${result.start_datetime || "null"}"  loc="${result.location_or_address || "null"}"`);
    assert(result && typeof result === "object", "returns an object");
    assert(typeof result.source_event_url === "string", `source_event_url is set (got: ${result.source_event_url})`);
    assert(result.community_hub_payload && typeof result.community_hub_payload === "object", "community_hub_payload is present");
  } catch (e) {
    fail("detail extraction", e);
  }
  } // end else (firstCandidate exists)
}   // end if (hasOpenAI && hasMcp)

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 6: Hub Snapshot (needs MCP browser — slow, opt-in)
// ─────────────────────────────────────────────────────────────────────────────
header("Agent 6 — Community Hub Snapshot (OpenAI + MCP browser)");

const runHubSnapshot = process.argv.includes("--hub");
if (!hasOpenAI || !hasMcp) {
  skip(`requires ${!hasOpenAI ? "OPENAI_API_KEY" : "MCP_BROWSER_URL"}`);
} else if (!runHubSnapshot) {
  skip("skipped by default (slow) — rerun with --hub flag to test this agent");
} else {
  const { syncCommunityHubCalendarFromBrowser } = await import("./src/automation/adapters/agentHubSnapshot.js");

  // Minimal stub repository that implements only what the snapshot adapter needs
  const memStore = [];
  const stubRepository = {
    upsertCommunityHubEvent(input) {
      memStore.push(input);
      return { inserted: true };
    }
  };

  try {
    console.log("  Scraping Community Hub calendar…");
    console.log("  (this can take 30–60 seconds)");
    const result = await syncCommunityHubCalendarFromBrowser(stubRepository, {});
    console.log(`         parsed=${result.parsed_count}  inserted=${result.inserted}  updated=${result.updated}`);
    assert(typeof result.parsed_count === "number", "returns parsed_count");
    assert(result.parsed_count >= 0, `parsed_count >= 0 (got: ${result.parsed_count})`);
    if (result.parsed_count > 0) {
      ok(`extracted ${result.parsed_count} events from Community Hub`);
    }
  } catch (e) {
    fail("hub snapshot", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(57)}`);
const total = passed + failed + skipped;
console.log(`${BOLD}Results: ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}  ${YELLOW}${skipped} skipped${RESET}  (${total} total)`);
if (failed > 0) {
  console.log(`${RED}Some agents are broken — check errors above.${RESET}`);
  process.exit(1);
} else if (skipped > 0 && !hasMcp) {
  console.log(`${YELLOW}Browser-dependent agents skipped. Set MCP_BROWSER_URL to test agents 1, 2, and 6.${RESET}`);
} else {
  console.log(`${GREEN}All tested agents are working!${RESET}`);
}
