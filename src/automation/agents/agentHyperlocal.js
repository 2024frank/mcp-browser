import OpenAI from "openai";

import { parseModelJsonOutput } from "../utils.js";

/**
 * Valid geographic scope values — ordered from smallest to largest.
 *  "hyperlocal"    → on the Oberlin College campus OR within Oberlin city limits
 *  "city"          → Oberlin area, within ~5 miles
 *  "lorain_county" → other Lorain County cities (Elyria, Amherst, Avon, etc.)
 *  "northeast_ohio"→ broader NE Ohio / Cleveland metro region
 *  "state"         → statewide Ohio event
 *  "national"      → nationwide scope
 *  "online"        → fully virtual, no physical location
 *  "unknown"       → insufficient location information
 */
const VALID_SCOPES = [
  "hyperlocal",
  "city",
  "lorain_county",
  "northeast_ohio",
  "state",
  "national",
  "online",
  "unknown"
];

const VALID_GEOGRAPHIC_TAGS = new Set([
  "oberlin",
  "lorain-county",
  "northeast-ohio",
  "ohio",
  "national",
  "online"
]);

function textHasAny(value, terms) {
  const text = String(value || "").toLowerCase();
  return terms.some((term) => text.includes(term));
}

function deriveHeuristicScope(event) {
  const merged = [
    event.title,
    event.organizational_sponsor,
    event.location_or_address,
    event.source_name,
    event.source_domain,
    event.source_event_url,
    event.source_listing_url,
    event.short_description,
    event.extended_description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const locationType = String(event.location_type || "").toLowerCase();
  if (locationType === "online" || textHasAny(merged, ["zoom", "livestream", "virtual event"])) {
    return { scope: "online", geographic_tags: ["online"], confidence: 0.85, reason: "online_event_detected" };
  }

  if (
    textHasAny(merged, [
      "oberlin",
      "tappan square",
      "finney chapel",
      "westervelt hall",
      "dye lecture hall",
      "allen memorial art museum",
      "apollo theatre oberlin"
    ])
  ) {
    return {
      scope: "hyperlocal",
      geographic_tags: ["oberlin", "lorain-county", "northeast-ohio", "ohio"],
      confidence: 0.75,
      reason: "oberlin_specific_venue_or_location"
    };
  }

  if (
    textHasAny(merged, [
      "elyria",
      "amherst",
      "lorain",
      "avon",
      "avon lake",
      "north ridgeville",
      "wellington",
      "sheffield",
      "vermilion",
      "lorain county"
    ])
  ) {
    return {
      scope: "lorain_county",
      geographic_tags: ["lorain-county", "northeast-ohio", "ohio"],
      confidence: 0.72,
      reason: "lorain_county_location_detected"
    };
  }

  if (
    textHasAny(merged, [
      "cleveland",
      "cuyahoga",
      "lakewood",
      "parma",
      "akron",
      "northeast ohio"
    ])
  ) {
    return {
      scope: "northeast_ohio",
      geographic_tags: ["northeast-ohio", "ohio"],
      confidence: 0.68,
      reason: "regional_location_detected"
    };
  }

  return null;
}

/**
 * Hyperlocal classifier agent (OpenAI Responses API — no browser needed).
 *
 * Classifies the geographic scope of an extracted event so that downstream
 * systems can display it on the right Community Dashboard screens:
 *  - hyperlocal / city → Oberlin dashboard signs
 *  - lorain_county     → Lorain County feed
 *  - northeast_ohio    → Cleveland / NE Ohio feed
 *
 * @param {object} event  - staging event shape (needs title, location fields, description)
 * @param {object} runtimeConfig
 * @returns {{ scope: string, geographic_tags: string[], confidence: number, reason: string }}
 */
export async function runHyperlocalAgent(event, runtimeConfig = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("hyperlocal agent requires OPENAI_API_KEY");
  }

  const model =
    process.env.OPENAI_HYPERLOCAL_MODEL ||
    process.env.OPENAI_AGENT_MODEL ||
    "gpt-4.1-mini";

  const client = new OpenAI({ apiKey });

  // Pass only the fields the agent needs — no browser, no MCP, pure text
  const eventSummary = {
    title: event.title || null,
    organizational_sponsor: event.organizational_sponsor || null,
    start_datetime: event.start_datetime || null,
    end_datetime: event.end_datetime || null,
    location_type: event.location_type || null,
    location_or_address: event.location_or_address || null,
    source_name: event.source_name || null,
    source_domain: event.source_domain || null,
    source_event_url: event.source_event_url || null,
    source_listing_url: event.source_listing_url || null,
    event_type_categories: Array.isArray(event.event_type_categories)
      ? event.event_type_categories.slice(0, 6)
      : [],
    short_description:
      typeof event.short_description === "string"
        ? event.short_description.slice(0, 300)
        : null,
    extended_description:
      typeof event.extended_description === "string"
        ? event.extended_description.slice(0, 600)
        : null
  };

  const input = `You are a geographic scope classifier for community events in and around Oberlin, Ohio.

Context:
- Oberlin is a small city in Lorain County, in Northeast Ohio, approximately 35 miles southwest of Cleveland.
- The Oberlin College campus is located within Oberlin city limits.
- Community Dashboard signs in Oberlin display hyperlocal and city-level events.
- A separate Lorain County feed covers events elsewhere in the county.
- A Northeast Ohio / Cleveland feed covers the broader regional area.
- The goal is to tag each event with the correct geographic scope so it appears on the right display.

Classify the geographic scope of this event:
${JSON.stringify(eventSummary, null, 2)}

Scope definitions:
- "hyperlocal" → event is explicitly on Oberlin College campus OR within Oberlin city limits
- "city" → event is in the Oberlin area, within approximately 5 miles
- "lorain_county" → event is in another Lorain County city (e.g. Elyria, Amherst, Avon, Lorain, Wellington)
- "northeast_ohio" → event serves the broader NE Ohio / Cleveland metro region
- "state" → event is Ohio-wide (no specific local venue)
- "national" → event has nationwide scope
- "online" → event is fully virtual with no in-person venue (location_type = "Online" or similar)
- "unknown" → insufficient information to determine location

For geographic_tags, include ALL applicable short tags from this fixed set:
["oberlin", "lorain-county", "northeast-ohio", "ohio", "national", "online"]

Examples:
- A concert at Finney Chapel → scope: "hyperlocal", tags: ["oberlin", "lorain-county", "northeast-ohio", "ohio"]
- A farmers market at Tappan Square → scope: "hyperlocal", tags: ["oberlin", "lorain-county"]
- A county fair in Elyria → scope: "lorain_county", tags: ["lorain-county", "northeast-ohio", "ohio"]
- A Zoom webinar, no venue → scope: "online", tags: ["online"]
- A statewide Ohio fundraiser → scope: "state", tags: ["ohio"]

Return a single JSON object only (no markdown):
{"scope":"string","geographic_tags":["string"],"confidence":number,"reason":"string"}

confidence should be a float 0–1 reflecting how certain you are of the classification.`;

  const heuristic = deriveHeuristicScope(eventSummary);
  if (heuristic && heuristic.confidence >= 0.8) {
    return heuristic;
  }

  const response = await client.responses.create({ model, input });

  const text = response.output_text || "";
  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
    throw new Error(
      `hyperlocal agent: bad JSON from model (${e.message}). Snippet: ${text.slice(0, 400)}`
    );
  }

  const scope = VALID_SCOPES.includes(parsed.scope) ? parsed.scope : "unknown";
  const geographic_tags = Array.isArray(parsed.geographic_tags)
    ? [...new Set(parsed.geographic_tags)]
        .filter((t) => typeof t === "string")
        .filter((t) => VALID_GEOGRAPHIC_TAGS.has(t))
    : [];
  const confidence = Number.isFinite(Number(parsed.confidence))
    ? Math.min(1, Math.max(0, Number(parsed.confidence)))
    : 0;

  return {
    scope: heuristic?.scope || scope,
    geographic_tags: heuristic?.geographic_tags?.length ? heuristic.geographic_tags : geographic_tags,
    confidence: Math.max(confidence, heuristic?.confidence || 0),
    reason:
      heuristic && heuristic.scope !== scope
        ? `${heuristic.reason}; model:${typeof parsed.reason === "string" ? parsed.reason : ""}`.trim()
        : typeof parsed.reason === "string"
          ? parsed.reason
          : heuristic?.reason || ""
  };
}
