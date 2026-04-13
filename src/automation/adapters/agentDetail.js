/**
 * Detail extractor agent (fault_agent: detail_extractor)
 * ------------------------------------------------------
 * Given one event URL (and optional title hint), uses OpenAI with remote Playwright MCP
 * to read the live page and emit JSON aligned with the Community Hub calendar form.
 * Applies fallbacks (title from URL/hint, sponsor from source), completeness scoring,
 * and consumes reviewer/QRepair guidance from agent_feedback when provided.
 */
import OpenAI from "openai";

import { dashboardPayloadToStagingEvent, normalizeDashboardSubmission } from "../community-hub.js";
import { parseModelJsonOutput } from "../utils.js";

function deriveTitleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const raw = decodeURIComponent(parts[parts.length - 1] || "");
    if (!raw) return null;
    return raw
      .replace(/[-_]+/g, " ")
      .replace(/\b(trailer and info|info|event|events)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase());
  } catch {
    return null;
  }
}

function enforceExtractionFallbacks(partial, source, candidate, eventUrl) {
  const patched = { ...(partial || {}) };
  patched.source_event_url = patched.source_event_url || eventUrl;
  patched.source_name = patched.source_name || source.source_name;

  if (!patched.title || !String(patched.title).trim()) {
    patched.title =
      candidate.title_hint?.trim() ||
      deriveTitleFromUrl(eventUrl) ||
      "Untitled Event";
  }
  if (!patched.organizational_sponsor || !String(patched.organizational_sponsor).trim()) {
    patched.organizational_sponsor = source.attribution_label || source.source_name || null;
  }
  if (!patched.location_type) {
    patched.location_type = "In-Person";
  }
  if (!Array.isArray(patched.event_type_categories)) {
    patched.event_type_categories = [];
  }
  if (patched.short_description_for_digital_signs === undefined && patched.short_description) {
    patched.short_description_for_digital_signs = patched.short_description;
  }
  if (
    patched.extended_description_for_web_and_newsletter === undefined &&
    patched.extended_description
  ) {
    patched.extended_description_for_web_and_newsletter = patched.extended_description;
  }
  return patched;
}

function computeCompleteness(hub) {
  const required = [
    "title",
    "organizational_sponsor",
    "start_datetime",
    "location_type",
    "source_name",
    "source_event_url"
  ];
  const missingRequired = required.filter((field) => {
    const value = hub?.[field];
    return value === null || value === undefined || String(value).trim() === "";
  });
  const qualityFields = [
    "end_datetime",
    "location_or_address",
    "short_description_for_digital_signs",
    "extended_description_for_web_and_newsletter",
    "artwork_upload_or_gallery"
  ];
  const presentQuality = qualityFields.filter((field) => {
    const value = hub?.[field];
    return value !== null && value !== undefined && String(value).trim() !== "";
  }).length;
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(((required.length - missingRequired.length) / required.length) * 75 + (presentQuality / qualityFields.length) * 25)
    )
  );
  return { required_fields: required, missing_required_fields: missingRequired, completeness_score: score };
}

/**
 * One event page → Community Hub dashboard–shaped JSON (OpenAI + remote Playwright MCP).
 */
export async function extractDashboardEventFromCandidate(source, candidate, runtimeConfig, feedbackGuidance = []) {
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

  const feedbackSection = feedbackGuidance.length
    ? `\nRecent reviewer feedback to avoid repeating mistakes:\n${feedbackGuidance.map((line) => `- ${line}`).join("\n")}\n`
    : "";

  const input = `You are an event detail extractor for the Oberlin Community Hub dashboard.

Use browser MCP tools for all navigation. Open this exact event page and read the visible event content:
${eventUrl}

Do not stop at the first snippet. You must gather all available fields from the page:
1) open the page
2) wait for dynamic content
3) take at least one snapshot
4) if needed, scroll and snapshot again
5) return the most complete possible record for form submission

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
If title is not clearly visible, use this listing hint as title: "${candidate.title_hint || "n/a"}".
Prefer complete structured output over partial output.
Link hint from listing: ${candidate.title_hint || "n/a"}
${feedbackSection}`;

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

  const hardened = enforceExtractionFallbacks(partial, source, candidate, eventUrl);

  const hub = normalizeDashboardSubmission(hardened, source);
  const stagingEvent = dashboardPayloadToStagingEvent(hub, source, candidate);
  const completeness = computeCompleteness(hub);
  stagingEvent.extraction_metadata = {
    extractor: "openai_detail_v1",
    model,
    source_event_url: eventUrl,
    required_fields: completeness.required_fields,
    missing_required_fields: completeness.missing_required_fields,
    completeness_score: completeness.completeness_score
  };
  return stagingEvent;
}
