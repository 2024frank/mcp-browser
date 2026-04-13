import OpenAI from "openai";

import { dashboardPayloadToStagingEvent, normalizeDashboardSubmission } from "../community-hub.js";
import { parseModelJsonOutput } from "../utils.js";

/**
 * One event page → Community Hub dashboard–shaped JSON (OpenAI + remote Playwright MCP).
 */
export async function extractDashboardEventFromCandidate(source, candidate, runtimeConfig) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("detail extraction requires OPENAI_API_KEY");
  }

  const mcpUrl = (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
  if (!mcpUrl) {
    throw new Error("detail extraction requires MCP_BROWSER_URL");
  }

  const model =
    process.env.OPENAI_DETAIL_MODEL ||
    process.env.OPENAI_AGENT_MODEL ||
    "gpt-4.1";

  const eventUrl = candidate.event_url;
  const client = new OpenAI({ apiKey });

  const input = `You are an event detail extractor for the Oberlin Community Hub dashboard.

Use browser MCP tools for all navigation. Open this exact event page and read the visible event content:
${eventUrl}

Extract data for the Environmental Dashboard calendar submission form. Return ONE JSON object only (no markdown), using these keys and constraints:

- post_type: "Event" (unless the page is clearly not an event)
- submitter_email: null (operator will fill in the dashboard)
- newsletter_opt_in: false
- guidelines_acknowledged: true
- contact_email, contact_phone, organization_website: null unless clearly shown as public contact on the page
- title: string (required)
- organizational_sponsor: string or null (host/department/sponsor)
- event_type_categories: array of short strings (infer 1–3 categories if possible, else [])
- start_datetime, end_datetime: ISO 8601 strings in local context if no timezone given use America/New_York intent
- location_type: one of "In-Person" | "Online" | "Both" | "Neither"
- location_or_address, room_number: strings or null
- event_link: online meeting link if any, else null
- short_description_for_digital_signs: short plain text for digital signs (max ~200 chars of content)
- extended_description_for_web_and_newsletter: longer description or null
- artwork_upload_or_gallery: image URL if there is a clear hero/poster image, else null
- display_target: "All Public Screens" unless the page explicitly says otherwise (then pick the closest enum: "All Public Screens" | "School Screens Only" | "School & Public Screens" | "Choose Specific Screens")
- source_name: "${source.source_name}"
- source_event_url: "${eventUrl}"

Do not invent dates or venues. If a field cannot be determined, use null or empty array as appropriate.
Link hint from listing: ${candidate.title_hint || "n/a"}`;

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
  let partial;
  try {
    partial = parseModelJsonOutput(text);
  } catch (e) {
    throw new Error(
      `detail extraction: invalid JSON (${e.message}). Snippet: ${text.slice(0, 400)}`
    );
  }

  partial.source_event_url = partial.source_event_url || eventUrl;

  const hub = normalizeDashboardSubmission(partial, source);
  const stagingEvent = dashboardPayloadToStagingEvent(hub, source, candidate);
  stagingEvent.extraction_metadata = {
    extractor: "openai_detail_v1",
    model,
    source_event_url: eventUrl
  };
  return stagingEvent;
}
