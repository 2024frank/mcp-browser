import OpenAI from "openai";

import { parseModelJsonOutput } from "../utils.js";

/** Canonical public listing used to refresh dedupe memory (browser snapshot, not an API). */
const DEFAULT_CALENDAR_URL =
  "https://environmentaldashboard.org/calendar/?show-menu-bar=1";

/**
 * Snapshot the public Community Hub *calendar web page* (not a Hub read API — there is none).
 * OpenAI Responses + remote Playwright MCP extract visible events from the HTML UI; results are
 * upserted into local SQLite `community_hub_events` for dedupe alignment. Coverage and freshness
 * depend on what the page shows and what the model parses; treat as auxiliary memory, not law.
 */
export async function syncCommunityHubCalendarFromBrowser(repository, runtimeConfig = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Community Hub snapshot requires OPENAI_API_KEY on the automation service");
  }

  const mcpUrl = (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
  if (!mcpUrl) {
    throw new Error(
      "Community Hub snapshot requires MCP_BROWSER_URL (e.g. https://<mcp-service>.onrender.com/mcp)"
    );
  }

  const calendarUrl =
    runtimeConfig.communityHubCalendarUrl ||
    process.env.COMMUNITY_HUB_CALENDAR_URL ||
    DEFAULT_CALENDAR_URL;

  const maxEvents = Number(
    runtimeConfig.communityHubSnapshotMaxEvents ??
      process.env.COMMUNITY_HUB_SNAPSHOT_MAX_EVENTS ??
      200
  );

  const model =
    runtimeConfig.communityHubSnapshotModel ||
    process.env.COMMUNITY_HUB_SNAPSHOT_MODEL ||
    process.env.OPENAI_AGENT_MODEL ||
    "gpt-4.1";

  const client = new OpenAI({ apiKey });

  const input = `You are extracting a snapshot of events from the Oberlin Community Events Calendar for deduplication memory.

Use browser MCP tools for navigation and snapshots. Follow these steps EXACTLY.

STEP 1: Navigate to this URL:
${calendarUrl}

STEP 2: Call browser_wait_for to wait up to 5 seconds for content to load.

STEP 3: Call browser_snapshot to capture the page.

STEP 4: Scroll down once to reveal any additional events below the fold, then snapshot again.

STEP 5: From what you can see in the snapshots, extract up to ${maxEvents} distinct event entries.
For each event record:
  - title: visible event name (string as shown)
  - start_datetime: ISO 8601 (assume America/New_York if no timezone given), or null
  - end_datetime: ISO 8601 or null
  - location_or_address: venue/address if shown, or null
  - short_description: short teaser or sign-line text visible in the calendar UI, or null if none shown
  - extended_description: longer body copy if visible in the snapshot (e.g. paragraph under the title on a detail page). Per-event pages often look like https://environmentaldashboard.org/calendar/post/3891?show-menu-bar=1 — if you only have the list view and no body text, use null. Plain text only (no HTML).
  - source_event_url: REQUIRED stable https URL for this specific event. If the listing shows a clickable title or "Details" link to a page on environmentaldashboard.org, use that full absolute URL (no trailing slash unless the site uses it). Only fall back to the calendar list URL "${calendarUrl}" if there is truly no per-event link in the snapshots.
  - community_hub_url: same as source_event_url for hub-hosted events

Dedup quality: distinct events must have distinct URLs when links exist; do not reuse the same placeholder URL for multiple different events unless unavoidable.
Optional: if many entries lack description text in the list snapshots, you may open a few distinct per-event environmentaldashboard.org URLs (navigate + snapshot) to capture extended_description — stay within roughly ${Math.min(20, Math.max(5, Math.floor(maxEvents / 10)))} extra navigations so the job finishes reliably.

CRITICAL OUTPUT RULES:
- You MUST output your final answer as a single JSON object. No markdown. No explanation text.
- Shape: {"events":[{"title":"...","start_datetime":"...","end_datetime":null,"location_or_address":null,"short_description":null,"extended_description":null,"source_event_url":"https://...","community_hub_url":"https://..."}]}
- If navigation fails or the page is empty, you MUST still output valid JSON: {"events":[]}
- Do NOT output any prose, explanation, or error messages. JSON ONLY.
- If you encounter any problem (lost context, navigation error, empty page), immediately output {"events":[]} and stop.`;

  const response = await client.responses.create({
    model,
    tools: [
      {
        type: "mcp",
        server_label: "playwright",
        server_description: "Playwright MCP for browser navigation and snapshots.",
        server_url: mcpUrl,
        require_approval: "never"
      }
    ],
    input
  });

  const text = response.output_text || "";

  // If the model emitted prose instead of JSON (navigation lost, page error),
  // treat it as an empty result rather than a hard crash.
  const looksLikeProse = text.trim() && !text.trim().startsWith("{") && !text.trim().startsWith("[");
  if (looksLikeProse) {
    console.warn(`hub snapshot: model returned prose instead of JSON — treating as empty. Snippet: "${text.slice(0, 200)}"`);
    return {
      calendar_url: calendarUrl,
      model,
      max_events_cap: maxEvents,
      parsed_count: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      warning: "model_returned_prose"
    };
  }

  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
    // Empty output_text means tool calls ran but no final JSON — return empty gracefully
    if (!text.trim()) {
      console.warn("hub snapshot: model output was empty — returning empty result");
      return {
        calendar_url: calendarUrl,
        model,
        max_events_cap: maxEvents,
        parsed_count: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        warning: "empty_model_output"
      };
    }
    throw new Error(
      `Community Hub snapshot: could not parse JSON from model (${e.message}). First 400 chars: ${text.slice(0, 400)}`
    );
  }

  const events = Array.isArray(parsed.events) ? parsed.events : [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const ev of events) {
    const url = typeof ev.source_event_url === "string" ? ev.source_event_url.trim() : "";
    if (!url) {
      skipped += 1;
      continue;
    }

    const shortDesc =
      typeof ev.short_description === "string" && ev.short_description.trim()
        ? ev.short_description.trim()
        : null;
    const extDesc =
      typeof ev.extended_description === "string" && ev.extended_description.trim()
        ? ev.extended_description.trim()
        : null;

    const result = repository.upsertCommunityHubEvent({
      title: typeof ev.title === "string" ? ev.title : null,
      start_datetime: typeof ev.start_datetime === "string" ? ev.start_datetime : null,
      end_datetime: typeof ev.end_datetime === "string" ? ev.end_datetime : null,
      location_or_address:
        typeof ev.location_or_address === "string" ? ev.location_or_address : null,
      short_description: shortDesc,
      extended_description: extDesc,
      source_event_url: url,
      community_hub_url:
        typeof ev.community_hub_url === "string" && ev.community_hub_url.trim()
          ? ev.community_hub_url.trim()
          : url,
      raw_payload: { snapshot: true, source: "agent_hub_snapshot", model }
    });

    if (result.inserted) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  return {
    calendar_url: calendarUrl,
    model,
    max_events_cap: maxEvents,
    parsed_count: events.length,
    inserted,
    updated,
    skipped
  };
}
