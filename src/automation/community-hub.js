import { firstNonEmpty, truncateText } from "./utils.js";

/**
 * Merge model output into a full Community Hub dashboard payload (form-ready).
 * Unknown / human-only fields stay null or safe defaults until someone edits in the dashboard.
 */
export function normalizeDashboardSubmission(partial, source) {
  const title = partial.title?.trim();
  if (!title) {
    throw new Error("dashboard submission requires title");
  }

  return {
    post_type: partial.post_type === "Announcement" ? "Announcement" : "Event",
    submitter_email: partial.submitter_email ?? null,
    newsletter_opt_in: Boolean(partial.newsletter_opt_in),
    guidelines_acknowledged: partial.guidelines_acknowledged !== false,
    contact_email: partial.contact_email ?? null,
    contact_phone: partial.contact_phone ?? null,
    organization_website: partial.organization_website ?? null,
    title,
    organizational_sponsor:
      partial.organizational_sponsor ?? source.attribution_label ?? source.source_name ?? null,
    event_type_categories: Array.isArray(partial.event_type_categories)
      ? partial.event_type_categories
      : [],
    start_datetime: partial.start_datetime,
    end_datetime: partial.end_datetime || partial.start_datetime,
    location_type: partial.location_type || "In-Person",
    location_or_address: partial.location_or_address ?? null,
    room_number: partial.room_number ?? null,
    event_link: partial.event_link ?? null,
    short_description_for_digital_signs:
      partial.short_description_for_digital_signs ??
      partial.short_description ??
      "",
    extended_description_for_web_and_newsletter:
      partial.extended_description_for_web_and_newsletter ??
      partial.extended_description ??
      "",
    artwork_upload_or_gallery: partial.artwork_upload_or_gallery ?? partial.artwork_url ?? null,
    display_target: partial.display_target || "All Public Screens",
    source_name: partial.source_name || source.source_name,
    source_event_url: partial.source_event_url,
    is_duplicate: null,
    duplicate_match_url: null
  };
}

/** Staging row shape + community_hub_payload from a normalized dashboard object. */
export function dashboardPayloadToStagingEvent(hub, source, candidate) {
  const sourceEventUrl = hub.source_event_url || candidate?.event_url;
  return {
    external_event_id: null,
    title: hub.title,
    organizational_sponsor: hub.organizational_sponsor,
    event_type_categories: hub.event_type_categories,
    start_datetime: hub.start_datetime,
    end_datetime: hub.end_datetime,
    location_type: hub.location_type,
    location_or_address: hub.location_or_address,
    room_number: hub.room_number,
    event_link: hub.event_link,
    short_description: hub.short_description_for_digital_signs,
    extended_description: hub.extended_description_for_web_and_newsletter,
    artwork_url: hub.artwork_upload_or_gallery,
    source_name: hub.source_name,
    source_domain: source.source_domain,
    source_listing_url: source.listing_url,
    source_event_url: sourceEventUrl,
    is_duplicate: null,
    duplicate_match_url: null,
    duplicate_reason: null,
    confidence: 0.85,
    review_status: "pending",
    community_hub_payload: hub,
    raw_payload: {
      extraction: "openai_detail_v1",
      title_hint: candidate?.title_hint
    }
  };
}

export function mapNormalizedEventToCommunityHub(event) {
  return {
    post_type: "Event",
    submitter_email: null,
    newsletter_opt_in: false,
    guidelines_acknowledged: true,
    contact_email: null,
    contact_phone: null,
    organization_website: null,
    title: event.title,
    organizational_sponsor: event.organizational_sponsor,
    event_type_categories: event.event_type_categories || [],
    start_datetime: event.start_datetime,
    end_datetime: event.end_datetime || event.start_datetime,
    location_type: event.location_type,
    location_or_address: event.location_or_address,
    room_number: event.room_number,
    event_link: event.event_link,
    short_description_for_digital_signs: firstNonEmpty(
      event.short_description,
      truncateText(event.extended_description, 200)
    ),
    extended_description_for_web_and_newsletter: event.extended_description,
    artwork_upload_or_gallery: event.artwork_url,
    display_target: "All Public Screens",
    source_name: event.source_name,
    source_event_url: event.source_event_url,
    is_duplicate: event.is_duplicate,
    duplicate_match_url: event.duplicate_match_url
  };
}
