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
  openaiDedupeEnabled: toBool(process.env.OPENAI_DEDUPE_ENABLED, false),
  openaiDedupeModel: process.env.OPENAI_DEDUPE_MODEL || "",
  openaiDedupeContextLimit: Number(process.env.OPENAI_DEDUPE_CONTEXT_LIMIT || 50),
  openaiDedupeMinConfidence: Number(process.env.OPENAI_DEDUPE_MIN_CONFIDENCE || 0.75),
  detailExtractionDelayMs: Number(process.env.DETAIL_EXTRACTION_DELAY_MS || 1500),
  communityHubCalendarUrl:
    process.env.COMMUNITY_HUB_CALENDAR_URL ||
    "https://environmentaldashboard.org/calendar?show-menu-bar=1",
  communityHubSnapshotMaxEvents: Number(process.env.COMMUNITY_HUB_SNAPSHOT_MAX_EVENTS || 200),
  communityHubSnapshotModel: process.env.COMMUNITY_HUB_SNAPSHOT_MODEL || ""
};
