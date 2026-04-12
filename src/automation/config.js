import fs from "node:fs";
import path from "node:path";

import { toBool } from "./utils.js";

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
  openaiDedupeMinConfidence: Number(process.env.OPENAI_DEDUPE_MIN_CONFIDENCE || 0.75)
};
