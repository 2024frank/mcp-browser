import { mapNormalizedEventToCommunityHub } from "../community-hub.js";
import {
  firstNonEmpty,
  makeFingerprint,
  sleep,
  stripHtml,
  truncateText
} from "../utils.js";

function getEventInstance(event) {
  return event.event_instances?.[0]?.event_instance || null;
}

function getLocalistEventUrl(event) {
  return firstNonEmpty(
    event.localist_url,
    event.url,
    event.urlname ? `https://calendar.oberlin.edu/event/${event.urlname}` : null
  );
}

function mapExperienceToLocationType(event) {
  const experience = String(event.experience || "").toLowerCase();
  if (experience === "online") {
    return "Online";
  }
  if (experience === "hybrid") {
    return "Both";
  }
  if (experience === "none") {
    return "Neither";
  }
  return "In-Person";
}

function extractSponsor(event, source) {
  const departmentNames =
    event.filters?.departments?.map((item) => item.name).filter(Boolean).join(", ") || null;

  return firstNonEmpty(
    event.custom_fields?.organizational_sponsor,
    departmentNames,
    event.custom_fields?.contact_person,
    source.attribution_label,
    source.source_name
  );
}

function matchesPublicRule(event, adapterConfig) {
  if (!adapterConfig.require_public) {
    return true;
  }

  const publicFilterKey = adapterConfig.public_filter_key || "event_public_events";
  const allowedLabels = adapterConfig.allowed_public_labels || [];
  const filterNames =
    event.filters?.[publicFilterKey]?.map((item) => item.name).filter(Boolean) || [];

  if (filterNames.length === 0) {
    return Boolean(adapterConfig.include_when_public_field_missing);
  }

  if (allowedLabels.length === 0) {
    return true;
  }

  return filterNames.some((name) => allowedLabels.includes(name));
}

function normalizeLocalistEvent(event, source) {
  const instance = getEventInstance(event);
  const descriptionText = stripHtml(event.description_text || event.description);
  const eventTypeCategories =
    event.filters?.event_types?.map((item) => item.name).filter(Boolean) || [];
  const sourceEventUrl = getLocalistEventUrl(event);

  const normalizedEvent = {
    external_event_id: String(event.id),
    title: event.title || null,
    organizational_sponsor: extractSponsor(event, source),
    event_type_categories: eventTypeCategories,
    start_datetime: instance?.start || null,
    end_datetime: instance?.end || null,
    location_type: mapExperienceToLocationType(event),
    location_or_address: firstNonEmpty(event.address, event.location_name, event.location),
    room_number: event.room_number || null,
    event_link: firstNonEmpty(sourceEventUrl, event.stream_url),
    short_description: truncateText(descriptionText, 200),
    extended_description: descriptionText,
    artwork_url: event.photo_url || null,
    source_name: source.source_name,
    source_domain: source.source_domain,
    source_listing_url: source.listing_url,
    source_event_url: sourceEventUrl,
    is_duplicate: null,
    duplicate_match_url: null,
    duplicate_reason: null,
    confidence: 0.95,
    review_status: "pending",
    raw_payload: event
  };

  normalizedEvent.community_hub_payload = mapNormalizedEventToCommunityHub(normalizedEvent);

  return normalizedEvent;
}

function toCandidate(event, source) {
  const sourceEventUrl = getLocalistEventUrl(event);

  return {
    external_event_id: String(event.id),
    event_url: sourceEventUrl,
    title_hint: event.title || null,
    fingerprint: makeFingerprint([source.id, event.id, sourceEventUrl]),
    raw_payload: event
  };
}

export async function runLocalistAdapter(source, runtimeConfig) {
  const adapterConfig = source.adapter_config || {};
  const days = Number(adapterConfig.days || 365);
  const perPage = Math.min(Number(adapterConfig.per_page || 100), 100);
  const maxPages = Math.max(1, Number(adapterConfig.max_pages || 5));
  const apiBaseUrl = (source.api_base_url || "").replace(/\/$/, "");
  const endpoint = `${apiBaseUrl}/events`;
  const candidates = [];
  const stagedEvents = [];
  let page = 1;
  let totalPages = 1;
  let eligibleCount = 0;

  while (page <= totalPages && page <= maxPages) {
    const url = new URL(endpoint);
    url.searchParams.set("days", String(days));
    url.searchParams.set("pp", String(perPage));
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        "user-agent": runtimeConfig.userAgent
      },
      signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Localist request failed for ${source.source_name}: ${response.status}`);
    }

    const payload = await response.json();
    const events = payload.events || [];
    const totalItems = Number(payload.page?.total || events.length || 0);
    totalPages = Math.max(1, Math.ceil(totalItems / perPage));

    for (const wrappedEvent of events) {
      const event = wrappedEvent.event;
      if (!event || event.status !== "live") {
        continue;
      }

      if (!matchesPublicRule(event, adapterConfig)) {
        continue;
      }

      eligibleCount += 1;
      candidates.push(toCandidate(event, source));
      stagedEvents.push(normalizeLocalistEvent(event, source));
    }

    page += 1;
    if (page <= totalPages && page <= maxPages) {
      await sleep(1100);
    }
  }

  return {
    candidates,
    stagedEvents,
    summary: {
      adapter: "localist_v1",
      eligible_events: eligibleCount,
      pages_scanned: Math.min(maxPages, totalPages)
    }
  };
}
