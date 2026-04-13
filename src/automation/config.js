import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toBool } from "./utils.js";

// ── Load .env from project root (dev convenience; no-op in prod if file absent) ──
try {
  const __dir  = path.dirname(fileURLToPath(import.meta.url));
  const envFile = path.join(__dir, "../../.env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[k]) process.env[k] = v; // never overwrite real env vars
    }
  }
} catch {
  // Silently ignore — .env is optional
}

const defaultDataDir = path.resolve(process.cwd(), "data/runtime");
const dataDir = process.env.DATA_DIR || defaultDataDir;

fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  port: Number(process.env.PORT || 10000),
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, "calendar-automation.db"),
  pollerEnabled: toBool(process.env.POLLER_ENABLED, true),
  pollerIntervalMs: Number(process.env.POLLER_INTERVAL_MS || 60_000),
  autoSeedSources: toBool(process.env.AUTO_SEED_SOURCES, true),
  seedSourcesPath:
    process.env.SEED_SOURCES_PATH || path.resolve(process.cwd(), "data/sources.example.json"),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20_000),
  userAgent:
    process.env.HTTP_USER_AGENT ||
    "oberlin-unified-calendar/0.1 (+https://environmentaldashboard.org/calendar)",
  /** Default on so dedupe vs hub mirror is useful; set OPENAI_DEDUPE_ENABLED=false to skip LLM compare costs. */
  openaiDedupeEnabled: toBool(process.env.OPENAI_DEDUPE_ENABLED, true),
  openaiDedupeModel: process.env.OPENAI_DEDUPE_MODEL || "",
  openaiDedupeContextLimit: Number(process.env.OPENAI_DEDUPE_CONTEXT_LIMIT || 50),
  openaiDedupeMinConfidence: Number(process.env.OPENAI_DEDUPE_MIN_CONFIDENCE || 0.75),
  detailExtractionDelayMs: Number(process.env.DETAIL_EXTRACTION_DELAY_MS || 1500),
  communityHubCalendarUrl:
    process.env.COMMUNITY_HUB_CALENDAR_URL ||
    "https://environmentaldashboard.org/calendar/?show-menu-bar=1",
  /**
   * Community Hub legacy JSON list (approved + future posts). Default: Oberlin tenant.
   * Set to empty string to disable and fall back to browser snapshot only.
   */
  communityHubLegacyPostsUrl: (() => {
    const v = process.env.COMMUNITY_HUB_LEGACY_POSTS_URL;
    if (v === "") {
      return null;
    }
    if (v != null && String(v).trim()) {
      return String(v).trim();
    }
    return "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?approved=1&filter=future";
  })(),
  /** Public permalink base for /calendar/post/:id (used when mirroring legacy API rows). */
  communityHubPublicPostBase:
    (process.env.COMMUNITY_HUB_PUBLIC_POST_BASE || "").trim() ||
    "https://environmentaldashboard.org/calendar/post",
  communityHubSnapshotMaxEvents: Number(process.env.COMMUNITY_HUB_SNAPSHOT_MAX_EVENTS || 200),
  communityHubSnapshotModel: process.env.COMMUNITY_HUB_SNAPSHOT_MODEL || "",
  /** Pilot: exclude events whose start is already in the past from human review (still stored for audit). */
  skipPastEventsForPipeline: toBool(process.env.SKIP_PAST_EVENTS, true),
  /** Hours of grace after nominal start (e.g. multi-day);0 = strict. */
  pastEventGraceHours: Number(process.env.PAST_EVENT_GRACE_HOURS || 0),
  /**
   * Day-of-week for Community Hub mirror sync (0=Sunday … 5=Friday … 6=Saturday).
   * When set, syncHubIfStale fires at most once per calendar day, only on that weekday
   * (evaluated in America/New_York time).
   * Leave unset (default) to fall back to interval-based HUB_SYNC_INTERVAL_MS throttle.
   */
  communityHubSyncDayOfWeek: (() => {
    const v = process.env.HUB_SYNC_DAY_OF_WEEK;
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
  })(),
  /** Optional label appended to source_runs.summary for experiment tracking. */
  researchExperimentId: (process.env.RESEARCH_EXPERIMENT_ID || "").trim() || null
};
