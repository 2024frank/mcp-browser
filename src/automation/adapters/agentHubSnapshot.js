import OpenAI from "openai";

import { parseModelJsonOutput } from "../utils.js";

const DEFAULT_CALENDAR_URL =
  "https://environmentaldashboard.org/calendar?show-menu-bar=1";

/**
 * Snapshot the public Community Hub calendar via OpenAI Responses + remote Playwright MCP,
 * then upsert rows into `community_hub_events` for dedupe alignment.
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
  - title: visible event name
  - start_datetime: ISO 8601 (assume America/New_York if no timezone given), or null
  - end_datetime: ISO 8601 or null
  - location_or_address: venue/address if shown, or null
  - source_event_url: the absolute https URL to that event's detail page on environmentaldashboard.org, OR if no detail link is visible, use the calendar URL itself as a placeholder
  - community_hub_url: same as source_event_url

CRITICAL OUTPUT RULES:
- You MUST output your final answer as a single JSON object. No markdown. No explanation text.
- Shape: {"events":[{"title":"...","start_datetime":"...","end_datetime":null,"location_or_address":null,"source_event_url":"https://...","community_hub_url":"https://..."}]}
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

    const result = repository.upsertCommunityHubEvent({
      title: typeof ev.title === "string" ? ev.title : null,
      start_datetime: typeof ev.start_datetime === "string" ? ev.start_datetime : null,
      end_datetime: typeof ev.end_datetime === "string" ? ev.end_datetime : null,
      location_or_address:
        typeof ev.location_or_address === "string" ? ev.location_or_address : null,
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
