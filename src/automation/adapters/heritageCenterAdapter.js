/**
 * Listing adapter — Oberlin Heritage Center (adapter: heritage_center_v1)
 * -----------------------------------------------------------------------
 * Fetches events directly from the WordPress ECS AJAX endpoint. No browser,
 * no OpenAI. Returns fully-shaped stagedEvents so the detail-extraction step
 * is skipped entirely.
 *
 * Endpoint: GET /wp-admin/admin-ajax.php?action=fetch_Events
 * Returns an array of event objects with title (HTML), start/end ISO strings,
 * venue fields, feature_image_calendar (HTML containing img src), and
 * post_event_excerpt.
 */
import { mapNormalizedEventToCommunityHub } from "../community-hub.js";
import { makeFingerprint, stripHtml, truncateText } from "../utils.js";

const AJAX_URL =
  "https://www.oberlinheritagecenter.org/wp-admin/admin-ajax.php?action=fetch_Events";

const DEFAULT_ADDRESS = "23 S. Main St., Oberlin, OH 44074";

function extractAttrFromHtml(html, attr) {
  if (!html) return null;
  const m = String(html).match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1] : null;
}

function buildStagedEvent(raw, source) {
  const title = stripHtml(raw.title)?.trim() || null;
  if (!title) return null;

  const sourceEventUrl =
    extractAttrFromHtml(raw.title, "href") ||
    extractAttrFromHtml(raw.view_more_button, "href") ||
    source.listing_url;

  const artworkUrl = extractAttrFromHtml(raw.feature_image_calendar, "src") || null;

  const locationParts = [raw.street, raw.locality, raw.state, raw.postal].filter(Boolean);
  const location = locationParts.length > 0 ? locationParts.join(", ") : DEFAULT_ADDRESS;

  const descRaw = stripHtml(raw.post_event_excerpt)?.trim() || null;

  const normalizedEvent = {
    external_event_id: null,
    title,
    organizational_sponsor: source.attribution_label || source.source_name,
    event_type_categories: [],
    start_datetime: raw.start || null,
    end_datetime: raw.end || raw.start || null,
    location_type: "In-Person",
    location_or_address: location,
    room_number: null,
    event_link: sourceEventUrl,
    short_description: truncateText(descRaw, 200),
    extended_description: descRaw,
    artwork_url: artworkUrl,
    source_name: source.source_name,
    source_domain: source.source_domain,
    source_listing_url: source.listing_url,
    source_event_url: sourceEventUrl,
    is_duplicate: null,
    duplicate_match_url: null,
    duplicate_reason: null,
    confidence: 0.9,
    review_status: "pending",
    raw_payload: raw
  };

  normalizedEvent.community_hub_payload = mapNormalizedEventToCommunityHub(normalizedEvent);
  return normalizedEvent;
}

export async function runHeritageCenterAdapter(source, runtimeConfig) {
  const res = await fetch(AJAX_URL, {
    headers: {
      Referer: "https://www.oberlinheritagecenter.org/events/",
      "User-Agent": runtimeConfig.userAgent || "oberlin-unified-calendar/0.1"
    },
    signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMs ?? 30_000)
  });

  if (!res.ok) {
    throw new Error(`Heritage Center AJAX returned HTTP ${res.status}`);
  }

  const events = await res.json();
  if (!Array.isArray(events)) {
    throw new Error("Heritage Center AJAX: unexpected response shape (not an array)");
  }

  const now = new Date().toISOString().slice(0, 10);
  const stagedEvents = events
    .filter((e) => e.start && e.start >= now)
    .map((e) => buildStagedEvent(e, source))
    .filter(Boolean);

  const candidates = stagedEvents.map((e) => ({
    external_event_id: null,
    event_url: e.source_event_url,
    title_hint: e.title,
    fingerprint: makeFingerprint([source.id, e.source_event_url, e.start_datetime || ""]),
    raw_payload: { adapter: "heritage_center_v1" }
  }));

  return {
    candidates,
    stagedEvents,
    summary: {
      adapter: "heritage_center_v1",
      eligible_events: stagedEvents.length
    }
  };
}
