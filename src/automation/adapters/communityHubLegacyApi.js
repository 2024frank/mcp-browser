/**
 * Sync `community_hub_events` from Community Hub "legacy" HTTP JSON (no browser / no OpenAI).
 * Example: https://oberlin.communityhub.cloud/api/legacy/calendar/posts?approved=1&filter=future
 */

const DEFAULT_POSTS_URL =
  "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?approved=1&filter=future";

const DEFAULT_PUBLIC_POST_BASE = "https://environmentaldashboard.org/calendar/post";

function unixToIso(sec) {
  if (sec == null || Number.isNaN(Number(sec))) {
    return null;
  }
  const n = Number(sec);
  if (!Number.isFinite(n)) {
    return null;
  }
  return new Date(Math.round(n * 1000)).toISOString();
}

/**
 * @param {object} post — one element from API `posts` array
 * @param {string} publicPostBase — e.g. https://environmentaldashboard.org/calendar/post (no trailing slash)
 */
export function legacyCalendarPostToHubInput(post, publicPostBase) {
  const id = post?.id;
  if (id == null) {
    return null;
  }
  const base = publicPostBase.replace(/\/$/, "");
  const sourceUrl = `${base}/${id}?show-menu-bar=1`;
  const loc = post.location;
  const location =
    (typeof loc?.address === "string" && loc.address.trim()) ||
    (typeof loc?.name === "string" && loc.name.trim()) ||
    null;
  const startSec = post.next?.start ?? post.sessions?.[0]?.start;
  const endSec = post.next?.end ?? post.sessions?.[0]?.end;
  const shortDesc =
    typeof post.description === "string" ? post.description.trim() || null : null;
  const extDesc =
    typeof post.extendedDescription === "string"
      ? post.extendedDescription.trim() || null
      : null;

  return {
    title: typeof post.name === "string" ? post.name.trim() || null : null,
    start_datetime: unixToIso(startSec),
    end_datetime: unixToIso(endSec),
    location_or_address: location,
    short_description: shortDesc,
    extended_description: extDesc,
    source_event_url: sourceUrl,
    community_hub_url: sourceUrl,
    raw_payload: {
      source: "community_hub_legacy_api",
      legacy_post_id: id,
      is_announcement: Boolean(post.isAnnouncement)
    }
  };
}

async function fetchLegacyPage(url, { userAgent, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent || "oberlin-unified-calendar/0.1"
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`legacy calendar API HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {import("../db.js").Repository} repository
 * @param {object} [runtimeConfig]
 * @param {string} [runtimeConfig.communityHubLegacyPostsUrl] — full URL with query (page/limit added)
 * @param {string} [runtimeConfig.communityHubPublicPostBase] — public /calendar/post base
 * @param {string} [runtimeConfig.userAgent]
 * @param {number} [runtimeConfig.requestTimeoutMs]
 * @param {number} [runtimeConfig.communityHubLegacyPageSize] — default 100
 */
export async function syncCommunityHubFromLegacyApi(repository, runtimeConfig = {}) {
  const postsListUrl =
    runtimeConfig.communityHubLegacyPostsUrl ||
    process.env.COMMUNITY_HUB_LEGACY_POSTS_URL ||
    DEFAULT_POSTS_URL;
  const publicPostBase =
    runtimeConfig.communityHubPublicPostBase ||
    process.env.COMMUNITY_HUB_PUBLIC_POST_BASE ||
    DEFAULT_PUBLIC_POST_BASE;
  const userAgent = runtimeConfig.userAgent || process.env.HTTP_USER_AGENT;
  const timeoutMs = Number(runtimeConfig.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS ?? 30_000);
  const pageSize = Number(
    runtimeConfig.communityHubLegacyPageSize ?? process.env.COMMUNITY_HUB_LEGACY_PAGE_SIZE ?? 100
  );

  const base = new URL(postsListUrl);
  base.searchParams.set("limit", String(Math.min(500, Math.max(1, pageSize))));

  let page = 0;
  let inserted = 0;
  let updated = 0;
  let parsedTotal = 0;
  let lastJson = null;

  for (;;) {
    base.searchParams.set("page", String(page));
    lastJson = await fetchLegacyPage(base.toString(), { userAgent, timeoutMs });
    const posts = Array.isArray(lastJson.posts) ? lastJson.posts : [];
    for (const post of posts) {
      const input = legacyCalendarPostToHubInput(post, publicPostBase);
      if (!input?.source_event_url) {
        continue;
      }
      parsedTotal += 1;
      const result = repository.upsertCommunityHubEvent(input);
      if (result.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }
    if (lastJson.lastPage === true || posts.length === 0) {
      break;
    }
    page += 1;
    if (page > 500) {
      console.warn("communityHubLegacyApi: stopped after 500 pages (safety cap)");
      break;
    }
  }

  return {
    source: "community_hub_legacy_api",
    api_url: base.origin + base.pathname,
    posts_list_query: Object.fromEntries(base.searchParams.entries()),
    pages_fetched: page + 1,
    api_reported_count: lastJson?.count,
    parsed_count: parsedTotal,
    inserted,
    updated
  };
}
