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

  const input = `You are extracting a snapshot of events from the Community Events Calendar for deduplication memory.

Use browser MCP for all navigation, waiting, scrolling, and snapshots.

1) Navigate to: ${calendarUrl}
2) Wait until the calendar or event list is visibly populated. If more events load on scroll, scroll reasonably to capture additional listings (cap at about ${maxEvents} distinct events for this run).
3) For each distinct public event you can associate with a stable URL on environmentaldashboard.org (or a detail page it links to), record:
   - title
   - start_datetime and end_datetime as ISO 8601 when possible (assume America/New_York if the page does not state a timezone)
   - location_or_address if shown
   - source_event_url: canonical public URL for that event (https, on environmentaldashboard.org when available)
   - community_hub_url: same as source_event_url when that is the hub-facing page; otherwise the best public permalink you found

Output rules:
- Return a single JSON object only (no markdown fences).
- Shape: {"events":[{"title":"string","start_datetime":"string|null","end_datetime":"string|null","location_or_address":"string|null","source_event_url":"string","community_hub_url":"string|null"}]}
- source_event_url must be present for every event; use absolute https URLs.
- Do not fabricate events: only include what you can justify from page content or links you followed from this calendar.
- Skip navigation, footer, and non-event links.`;

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
  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
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
