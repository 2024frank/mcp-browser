/**
 * Listing / ingest adapter — ICS feeds (adapter: ics_v1)
 * -----------------------------------------------------
 * Parses public .ics URLs into Community Hub–shaped events; listing_agent issues
 * usually mean feed URL or parse configuration, not LLM extraction.
 */
import * as ical from "node-ical";

import { mapNormalizedEventToCommunityHub } from "../community-hub.js";
import {
  makeFingerprint,
  normalizeUrl,
  stripHtml,
  truncateText
} from "../utils.js";

function mapLocationType(entry) {
  if (entry.location && entry.url) {
    return "Both";
  }
  if (entry.url) {
    return "Online";
  }
  if (entry.location) {
    return "In-Person";
  }
  return "Neither";
}

export async function runIcsAdapter(source, runtimeConfig) {
  const feedUrl = source.ics_url || source.listing_url;
  const response = await fetch(feedUrl, {
    headers: {
      "user-agent": runtimeConfig.userAgent
    },
    signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`ICS request failed for ${source.source_name}: ${response.status}`);
  }

  const rawText = await response.text();
  const parsed = ical.parseICS(rawText);
  const candidates = [];
  const stagedEvents = [];

  for (const entry of Object.values(parsed)) {
    if (!entry || entry.type !== "VEVENT") {
      continue;
    }

    const sourceEventUrl = normalizeUrl(entry.url, source.listing_url) || `ics:${entry.uid}`;
    const description = stripHtml(entry.description);
    const normalizedEvent = {
      external_event_id: entry.uid || null,
      title: entry.summary || null,
      organizational_sponsor: source.attribution_label || source.source_name,
      event_type_categories: [],
      start_datetime: entry.start ? new Date(entry.start).toISOString() : null,
      end_datetime: entry.end ? new Date(entry.end).toISOString() : null,
      location_type: mapLocationType(entry),
      location_or_address: entry.location || null,
      room_number: null,
      event_link: normalizeUrl(entry.url, source.listing_url),
      short_description: truncateText(description, 200),
      extended_description: description,
      artwork_url: null,
      source_name: source.source_name,
      source_domain: source.source_domain,
      source_listing_url: source.listing_url,
      source_event_url: sourceEventUrl,
      is_duplicate: null,
      duplicate_match_url: null,
      duplicate_reason: null,
      confidence: 0.85,
      review_status: "pending",
      raw_payload: entry
    };

    normalizedEvent.community_hub_payload = mapNormalizedEventToCommunityHub(normalizedEvent);

    candidates.push({
      external_event_id: entry.uid || null,
      event_url: sourceEventUrl,
      title_hint: entry.summary || null,
      fingerprint: makeFingerprint([source.id, entry.uid, sourceEventUrl]),
      raw_payload: entry
    });
    stagedEvents.push(normalizedEvent);
  }

  return {
    candidates,
    stagedEvents,
    summary: {
      adapter: "ics_v1",
      eligible_events: stagedEvents.length,
      pages_scanned: 1
    }
  };
}
