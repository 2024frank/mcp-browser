import OpenAI from "openai";

import {
  dashboardPayloadToStagingEvent,
  normalizeDashboardSubmission
} from "../community-hub.js";
import { makeFingerprint, parseModelJsonOutput } from "../utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("openai_listing_v1 requires OPENAI_API_KEY on the automation service");
  return new OpenAI({ apiKey });
}

function getMcpUrl() {
  const url = (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
  if (!url) throw new Error("openai_listing_v1 requires MCP_BROWSER_URL (e.g. https://<mcp-service>.onrender.com/mcp)");
  return url;
}

const MCP_TOOL = (mcpUrl) => ({
  type: "mcp",
  server_label: "playwright",
  server_description: "Playwright MCP for browser navigation and snapshots.",
  server_url: mcpUrl,
  require_approval: "never"
});

// ── Standard listing agent (find individual event URLs) ───────────────────────

/**
 * Listing collection via OpenAI Responses API + remote Playwright MCP.
 * Navigates the listing page and returns individual event detail URLs.
 * Use when the source has deep-linked individual event pages.
 */
export async function runOpenAiListingAdapter(source, runtimeConfig) {
  const adapterConfig = source.adapter_config || {};

  // Route to single-page extraction when the source is a calendar grid
  // that shows all event data on one page rather than individual detail pages.
  if (adapterConfig.single_page_extraction) {
    return await runSinglePageExtractionAdapter(source, runtimeConfig, adapterConfig);
  }

  const client   = getOpenAiClient();
  const mcpUrl   = getMcpUrl();
  const model    = process.env.OPENAI_AGENT_MODEL || "gpt-4.1";
  const maxLinks = Number(adapterConfig.max_links || 25);
  const allowedHosts = adapterConfig.allowed_hosts || [];
  const listingUrl   = source.listing_url;
  const hostsLine    = allowedHosts.length > 0
    ? `Only include links whose hostname is one of: ${allowedHosts.join(", ")}.`
    : "";

  const input = `You are a listing collector agent. Use the browser MCP tools for every navigation and snapshot.

Task:
1) Open this listing page: ${listingUrl}
2) After navigation, wait for meaningful content, then snapshot the page.
3) Collect up to ${maxLinks} links that point to individual event detail pages (not the listing page URL itself).
4) Ignore header, footer, navigation, filters, category pages, search, and social links.
${hostsLine}
5) If there is a clear "next page" link for the event listing pagination, return its absolute URL as next_page_url; otherwise return an empty string for next_page_url.

Output rules:
- Return a single JSON object only (no markdown fences).
- Shape: {"event_links":[{"title_hint":"string","event_url":"string"}],"next_page_url":"string"}
- event_url values must be absolute https URLs.
- title_hint should be the visible link text when available.`;

  const response = await client.responses.create({
    model,
    tools: [MCP_TOOL(mcpUrl)],
    input
  });

  const text = response.output_text || "";
  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
    const outputItems = Array.isArray(response.output) ? response.output : [];
    const itemsSummary = outputItems
      .map((item, i) => {
        if (item.type === "message") {
          const content = Array.isArray(item.content)
            ? item.content.map(c => c.text || c.type || "").join(" ")
            : String(item.content || "");
          return `[${i}:message] ${content.slice(0, 200)}`;
        }
        return `[${i}:${item.type}]`;
      })
      .join(" | ");
    throw new Error(
      `openai_listing_v1: could not parse JSON from model (${e.message}). ` +
      `output_text="${text.slice(0, 400)}" output_items="${itemsSummary.slice(0, 400)}"`
    );
  }

  const links       = Array.isArray(parsed.event_links) ? parsed.event_links : [];
  const nextPageUrl = typeof parsed.next_page_url === "string" ? parsed.next_page_url : "";

  const candidates = [];
  const seen = new Set();
  for (const row of links) {
    if (candidates.length >= maxLinks) break;
    const eventUrl = row?.event_url;
    if (!eventUrl || typeof eventUrl !== "string") continue;
    if (seen.has(eventUrl)) continue;
    seen.add(eventUrl);
    candidates.push({
      external_event_id: null,
      event_url: eventUrl,
      title_hint: row.title_hint || null,
      fingerprint: makeFingerprint([source.id, eventUrl]),
      raw_payload: {
        title_hint: row.title_hint || null,
        event_url: eventUrl,
        adapter: "openai_listing_v1"
      }
    });
  }

  return {
    candidates,
    stagedEvents: [],
    summary: {
      adapter: "openai_listing_v1",
      eligible_events: candidates.length,
      next_page_url: nextPageUrl,
      model,
      mcp_host: new URL(mcpUrl).host
    }
  };
}

// ── Single-page extraction agent ──────────────────────────────────────────────

/**
 * Single-page extraction mode — navigates to the listing page ONCE and extracts
 * ALL visible events in one LLM call.  Use this for:
 *  - Calendar widget pages (FAVA, Library, Heritage)
 *  - Sites where individual event URLs don't exist or lead to the same page
 *  - Sites where the listing page itself contains all the event detail we need
 *
 * Set `adapter_config.single_page_extraction: true` to enable.
 * Optional: `adapter_config.max_events_from_listing` (default 40).
 */
async function runSinglePageExtractionAdapter(source, runtimeConfig, adapterConfig) {
  const client   = getOpenAiClient();
  const mcpUrl   = getMcpUrl();
  const model    = process.env.OPENAI_AGENT_MODEL || "gpt-4.1";
  const maxEvents = Number(adapterConfig.max_events_from_listing || 40);
  const listingUrl = source.listing_url;
  const sponsor    = source.attribution_label || source.source_name;

  const input = `You are extracting community events from a public events listing page.

Use Playwright browser tools. Follow these steps IN ORDER:

STEP 1: Navigate to: ${listingUrl}
STEP 2: Call browser_wait_for to wait up to 5000ms for content to load.
STEP 3: Call browser_snapshot to capture the visible page.
STEP 4: Scroll down to reveal more events.
STEP 5: Call browser_snapshot again to capture the rest of the page.

STEP 6: From both snapshots, extract every distinct event you can identify (up to ${maxEvents}).
Skip duplicates, non-events (navigation, ads, staff bios), and past events if dates are shown.

For each event extract:
  - title: event name (string, required — skip event if missing)
  - organizational_sponsor: host/organizer — use "${sponsor}" if not clearly shown
  - start_datetime: ISO 8601 in America/New_York timezone — required (skip event if no date visible)
  - end_datetime: ISO 8601 or null
  - location_type: "In-Person" | "Online" | "Both" | "Neither"
  - location_or_address: venue/address if shown, null otherwise
  - short_description_for_digital_signs: brief plain-text summary up to ~200 chars, or null
  - event_type_categories: array of 1–3 short category labels e.g. ["Arts","Community"] or []
  - artwork_upload_or_gallery: absolute URL of the event's image if clearly shown, null otherwise
  - source_event_url: absolute URL to the individual event detail page if a link exists; otherwise use "${listingUrl}"

FINAL OUTPUT — REQUIRED RULES:
- A SINGLE JSON object. NO markdown. NO explanation text before or after.
- Shape: {"events":[{...}],"event_count":N}
- If the page fails to load or shows no events: {"events":[],"event_count":0}`;

  const response = await client.responses.create({
    model,
    tools: [MCP_TOOL(mcpUrl)],
    input
  });

  const text = response.output_text || "";

  // Graceful fallback if model returned prose or nothing
  const looksLikeProse = text.trim() && !text.trim().startsWith("{") && !text.trim().startsWith("[");
  if (looksLikeProse || !text.trim()) {
    console.warn(`single_page_extraction (${source.source_id}): model returned prose/empty — treating as empty. Snippet: "${text.slice(0, 200)}"`);
    return {
      candidates: [],
      stagedEvents: [],
      summary: { adapter: "single_page_extraction_v1", eligible_events: 0, warning: "model_returned_prose", model }
    };
  }

  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
    throw new Error(`single_page_extraction: invalid JSON (${e.message}). Snippet: ${text.slice(0, 400)}`);
  }

  const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const candidates  = [];
  const stagedEvents = [];
  const seen = new Set();

  for (const ev of rawEvents) {
    // Skip if no title or no date (the two hard requirements)
    if (!ev.title?.trim() || !ev.start_datetime) continue;

    const eventUrl = typeof ev.source_event_url === "string" && ev.source_event_url.startsWith("http")
      ? ev.source_event_url
      : listingUrl;

    // Deduplicate by URL+title combo
    const dedupeKey = `${eventUrl}::${ev.title.trim().toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const candidate = {
      external_event_id: null,
      event_url: eventUrl,
      title_hint: ev.title.trim() || null,
      fingerprint: makeFingerprint([source.id, dedupeKey]),
      raw_payload: { adapter: "single_page_extraction_v1", title: ev.title }
    };

    let stagingEvent;
    try {
      const hub = normalizeDashboardSubmission({
        ...ev,
        post_type: "Event",
        source_name: source.source_name,
        source_event_url: eventUrl
      }, source);
      stagingEvent = dashboardPayloadToStagingEvent(hub, source, candidate);
    } catch (err) {
      // normalizeDashboardSubmission throws if title is missing — already checked above
      console.warn(`single_page_extraction: skipping event "${ev.title}" — ${err.message}`);
      continue;
    }

    candidates.push(candidate);
    stagedEvents.push(stagingEvent);
  }

  return {
    candidates,
    stagedEvents,
    summary: {
      adapter: "single_page_extraction_v1",
      eligible_events: stagedEvents.length,
      raw_extracted: rawEvents.length,
      model,
      mcp_host: new URL(mcpUrl).host
    }
  };
}
