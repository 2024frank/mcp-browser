/**
 * Fetch ALL events from Experience Oberlin (Locable widget) using OpenAI + Playwright MCP.
 * The MCP browser runs on Render and is not blocked by Cloudflare the same way.
 *
 * Usage:
 *   npm run fetch:experience-oberlin-mcp
 *   npm run fetch:experience-oberlin-mcp -- --json   (machine-readable JSON)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

// Load .env from project root (same as config.js)
try {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const envFile = path.join(__dir, "../.env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch { /* ignore */ }

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

const mcpUrl = process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL;
if (!mcpUrl) { console.error("MCP_BROWSER_URL not set"); process.exit(1); }

const model = process.env.OPENAI_AGENT_MODEL || "gpt-4.1";
const jsonOutput = process.argv.includes("--json");
const log = (...a) => { if (!jsonOutput) console.error(...a); };

const TARGET_URL = "https://www.experienceoberlin.com/events";

log(`Using model: ${model}`);
log(`Using MCP:   ${mcpUrl}`);
log(`Fetching:    ${TARGET_URL}`);

const client = new OpenAI({ apiKey });

const prompt = `You are an event extraction agent for the Oberlin community calendar project.

Use browser MCP tools for all navigation and snapshots. Follow these steps EXACTLY.

STEP 1: Navigate to this URL:
${TARGET_URL}

STEP 2: Call browser_wait_for to wait up to 8 seconds for content to load.

STEP 3: Call browser_snapshot to capture the page.

STEP 4: Scroll down to reveal the event listing (the page says "DISPLAYING X EVENTS" and lists upcoming events with title, date/time, and address). Snapshot again after scrolling.

STEP 5: Extract all visible events from the current page. For each event record:
  - title: the event name exactly as shown
  - datetime: the date and time string exactly as shown (e.g. "Apr 13, 2026, 3:30 PM EDT")
  - location: venue name and/or address if visible
  - description: any short description text shown under the title, or null

STEP 6: Look at the bottom of the event list for pagination — "Next ›" link or numbered pages. If a Next page exists and is not greyed out/disabled, click it, call browser_wait_for 5 seconds, snapshot, and extract events from that page too. Repeat this until there is no Next link or you have paginated through at least 30 pages.

STEP 7: Return ALL events collected across all pages.

CRITICAL OUTPUT RULES:
- You MUST output your final answer as a single JSON object. No markdown. No explanation text.
- Shape: {"total_shown": <number from "DISPLAYING X EVENTS" header>, "pages_scraped": <number>, "events": [{"title":"...","datetime":"...","location":null,"description":null}]}
- If navigation fails or the page is empty, you MUST still output valid JSON: {"total_shown":0,"pages_scraped":0,"events":[]}
- Do NOT output any prose, explanation, or error messages. JSON ONLY.
- If you encounter any problem (security check, empty page, lost context), immediately output {"total_shown":0,"pages_scraped":0,"events":[]} and stop.`;

log("Calling OpenAI with MCP browser tool...");

const response = await client.responses.create({
  model,
  tools: [
    {
      type: "mcp",
      server_label: "playwright",
      server_description: "Playwright MCP browser for navigation and snapshots.",
      server_url: mcpUrl,
      require_approval: "never",
    },
  ],
  input: prompt,
});

const text = response.output_text || "";
log(`\nRaw output length: ${text.length}`);

// Parse JSON from model output
let parsed;
try {
  const match = text.match(/\{[\s\S]*\}/);
  parsed = JSON.parse(match ? match[0] : text);
} catch (e) {
  console.error("Could not parse JSON from model output:", e.message);
  console.error("Raw output:", text.slice(0, 800));
  process.exit(1);
}

if (jsonOutput) {
  console.log(JSON.stringify(parsed, null, 2));
} else {
  const events = parsed.events || [];
  console.log(`\n${"=".repeat(60)}`);
  console.log(`EXPERIENCE OBERLIN — ${events.length} EVENTS (of ${parsed.total || "?"} total)`);
  console.log("=".repeat(60));
  events.forEach((ev, i) => {
    console.log(`\n[${i + 1}] ${ev.title}`);
    if (ev.datetime)     console.log(`    When:  ${ev.datetime}`);
    if (ev.location)     console.log(`    Where: ${ev.location}`);
    if (ev.description)  console.log(`    Desc:  ${ev.description.slice(0, 120)}`);
  });
  if (parsed.error) console.error("\nError from agent:", parsed.error);
}
