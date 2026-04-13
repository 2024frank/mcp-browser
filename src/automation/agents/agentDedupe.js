import OpenAI from "openai";

import { parseModelJsonOutput } from "../utils.js";

/**
 * Build compact context for duplicate comparison (no browser / no MCP).
 */
export function buildDedupeContext(repository, currentSourceId, limit = 50) {
  const staging = repository
    .listStaging({ sourceId: null, limit: Math.min(200, limit * 3) })
    .filter((r) => r.source_id !== currentSourceId)
    .slice(0, limit)
    .map((r) => ({
      title: r.title,
      start_datetime: r.start_datetime,
      end_datetime: r.end_datetime,
      location_or_address: r.location_or_address,
      source_event_url: r.source_event_url,
      source_name: r.source_name
    }));

  const hub = repository.listHubEvents(limit).map((r) => ({
    title: r.title,
    start_datetime: r.start_datetime,
    end_datetime: r.end_datetime,
    location_or_address: r.location_or_address,
    source_event_url: r.source_event_url,
    community_hub_url: r.community_hub_url
  }));

  return { staging, hub };
}

/**
 * LLM duplicate comparator: runs after deterministic SQL rules.
 * Does not use Playwright MCP — only structured JSON comparison.
 */
export async function runDuplicateCompareAgent(incomingEvent, context, runtimeConfig, feedbackGuidance = []) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("duplicate compare agent requires OPENAI_API_KEY");
  }

  const model =
    runtimeConfig.openaiDedupeModel ||
    process.env.OPENAI_DEDUPE_MODEL ||
    process.env.OPENAI_AGENT_MODEL ||
    "gpt-4.1-mini";

  const minConfidence = Number(
    runtimeConfig.openaiDedupeMinConfidence ??
      process.env.OPENAI_DEDUPE_MIN_CONFIDENCE ??
      0.75
  );

  const client = new OpenAI({ apiKey });

  const incoming = {
    title: incomingEvent.title,
    start_datetime: incomingEvent.start_datetime,
    end_datetime: incomingEvent.end_datetime,
    location_or_address: incomingEvent.location_or_address,
    source_event_url: incomingEvent.source_event_url,
    source_name: incomingEvent.source_name,
    organizational_sponsor: incomingEvent.organizational_sponsor
  };

  const feedbackSection = feedbackGuidance.length
    ? `\nRecent reviewer feedback to avoid repeating mistakes:\n${feedbackGuidance.map((line) => `- ${line}`).join("\n")}\n`
    : "";
  const input = `You are a duplicate-detection agent for community calendar events.

Rules:
- Mark is_duplicate true ONLY if the incoming event is almost certainly the SAME real-world occurrence as one existing row (same event, not just same day or same venue).
- Same title with different dates = usually NOT duplicate.
- Different URLs can still be duplicates if clearly the same event cross-posted.
- When is_duplicate is true, duplicate_match_url MUST be the source_event_url OR community_hub_url of the matching existing row you chose (copy exactly from context).
- Be conservative: when unsure, set is_duplicate false and confidence under ${minConfidence}.

Return a single JSON object only (no markdown), shape:
{"is_duplicate":boolean,"duplicate_match_url":string|null,"duplicate_reason":string,"confidence":number}

incoming:
${JSON.stringify(incoming, null, 2)}

existing_staging (other sources):
${JSON.stringify(context.staging, null, 2)}

published_hub:
${JSON.stringify(context.hub, null, 2)}
${feedbackSection}`;

  const response = await client.responses.create({
    model,
    input
  });

  const text = response.output_text || "";
  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
    throw new Error(
      `duplicate agent: bad JSON (${e.message}). Snippet: ${text.slice(0, 400)}`
    );
  }

  const confidence = Number(parsed.confidence);
  const dup = parsed.is_duplicate === true;
  const confidentEnough = !Number.isNaN(confidence) && confidence >= minConfidence;
  const knownUrls = new Set([
    ...context.staging.flatMap((row) => [row.source_event_url]),
    ...context.hub.flatMap((row) => [row.source_event_url, row.community_hub_url])
  ].filter(Boolean));
  const selectedUrl =
    typeof parsed.duplicate_match_url === "string" ? String(parsed.duplicate_match_url) : null;
  const validSelectedUrl = selectedUrl && knownUrls.has(selectedUrl);

  if (dup && confidentEnough && validSelectedUrl) {
    return {
      applied: true,
      is_duplicate: true,
      duplicate_match_url: selectedUrl,
      duplicate_reason: `llm_duplicate_compare:${parsed.duplicate_reason || "model_match"}`,
      duplicate_agent_confidence: confidence
    };
  }

  return {
    applied: false,
    duplicate_agent_confidence: confidence,
    invalid_match_url: dup && confidentEnough && !!selectedUrl && !validSelectedUrl
  };
}
