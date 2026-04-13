import fs from "node:fs";

import Database from "better-sqlite3";

import { addMinutes, eventTitleKey, makeId, normalizeCanonicalEventUrl, nowIso, parseJson } from "./utils.js";

function sourceRowToObject(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    source_name: row.source_name,
    source_domain: row.source_domain,
    source_type: row.source_type,
    listing_url: row.listing_url,
    api_base_url: row.api_base_url,
    ics_url: row.ics_url,
    adapter_key: row.adapter_key,
    poll_interval_minutes: row.poll_interval_minutes,
    is_active: Boolean(row.is_active),
    attribution_label: row.attribution_label,
    notes: row.notes,
    adapter_config: parseJson(row.adapter_config_json, {}),
    last_polled_at: row.last_polled_at,
    next_run_at: row.next_run_at,
    last_run_status: row.last_run_status,
    last_run_error: row.last_run_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function candidateRowToObject(row) {
  return {
    id: row.id,
    source_id: row.source_id,
    external_event_id: row.external_event_id,
    event_url: row.event_url,
    title_hint: row.title_hint,
    fingerprint: row.fingerprint,
    discovered_at: row.discovered_at,
    last_seen_at: row.last_seen_at,
    status: row.status,
    raw_payload: parseJson(row.raw_payload_json, null)
  };
}

function stagingRowToObject(row) {
  return {
    id: row.id,
    source_id: row.source_id,
    source_candidate_id: row.source_candidate_id,
    external_event_id: row.external_event_id,
    title: row.title,
    organizational_sponsor: row.organizational_sponsor,
    event_type_categories: parseJson(row.event_type_categories_json, []),
    start_datetime: row.start_datetime,
    end_datetime: row.end_datetime,
    location_type: row.location_type,
    location_or_address: row.location_or_address,
    room_number: row.room_number,
    event_link: row.event_link,
    short_description: row.short_description,
    extended_description: row.extended_description,
    artwork_url: row.artwork_url,
    source_name: row.source_name,
    source_domain: row.source_domain,
    source_listing_url: row.source_listing_url,
    source_event_url: row.source_event_url,
    is_duplicate: row.is_duplicate === null ? null : Boolean(row.is_duplicate),
    duplicate_match_url: row.duplicate_match_url,
    duplicate_reason: row.duplicate_reason,
    confidence: row.confidence,
    review_status: row.review_status,
    ai_baseline_payload: parseJson(row.ai_baseline_payload_json, null),
    extraction_metadata: parseJson(row.extraction_metadata_json, {}),
    reviewed_at: row.reviewed_at || null,
    hyperlocal_scope: row.hyperlocal_scope || null,
    geographic_tags: parseJson(row.geographic_tags_json, []),
    community_hub_payload: parseJson(row.community_hub_payload_json, {}),
    raw_payload: parseJson(row.raw_payload_json, null),
    discovered_at: row.discovered_at,
    updated_at: row.updated_at
  };
}

function runRowToObject(row) {
  return {
    id: row.id,
    source_id: row.source_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    new_candidates: row.new_candidates,
    upserted_events: row.upserted_events,
    error_message: row.error_message,
    summary: parseJson(row.summary_json, {})
  };
}

const REVIEW_TRACKED_FIELDS = [
  "title",
  "organizational_sponsor",
  "start_datetime",
  "end_datetime",
  "location_type",
  "location_or_address",
  "room_number",
  "event_link",
  "short_description",
  "extended_description",
  "artwork_url",
  "is_duplicate",
  "duplicate_match_url",
  "duplicate_reason",
  "review_status"
];

const ACCURACY_COMPARISON_FIELDS = REVIEW_TRACKED_FIELDS.filter(
  (field) => field !== "review_status"
);

function buildReviewSnapshot(event) {
  return {
    title: event.title || null,
    organizational_sponsor: event.organizational_sponsor || null,
    start_datetime: event.start_datetime || null,
    end_datetime: event.end_datetime || null,
    location_type: event.location_type || null,
    location_or_address: event.location_or_address || null,
    room_number: event.room_number || null,
    event_link: event.event_link || null,
    short_description: event.short_description || null,
    extended_description: event.extended_description || null,
    artwork_url: event.artwork_url || null,
    is_duplicate:
      event.is_duplicate === null || event.is_duplicate === undefined
        ? null
        : Boolean(event.is_duplicate),
    duplicate_match_url: event.duplicate_match_url || null,
    duplicate_reason: event.duplicate_reason || null,
    review_status: event.review_status || "pending"
  };
}

function diffReviewFields(before, after) {
  return REVIEW_TRACKED_FIELDS.filter((field) => {
    return JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null);
  });
}

function syncCommunityHubPayload(payload, snapshot) {
  return {
    ...(payload || {}),
    title: snapshot.title,
    organizational_sponsor: snapshot.organizational_sponsor,
    start_datetime: snapshot.start_datetime,
    end_datetime: snapshot.end_datetime,
    location_type: snapshot.location_type,
    location_or_address: snapshot.location_or_address,
    room_number: snapshot.room_number,
    event_link: snapshot.event_link,
    short_description_for_digital_signs: snapshot.short_description || "",
    extended_description_for_web_and_newsletter: snapshot.extended_description || "",
    artwork_upload_or_gallery: snapshot.artwork_url || null,
    is_duplicate: snapshot.is_duplicate,
    duplicate_match_url: snapshot.duplicate_match_url
  };
}

function reviewRowToObject(row) {
  return {
    id: row.id,
    staging_event_id: row.staging_event_id,
    review_action: row.review_action,
    reviewer_name: row.reviewer_name,
    review_note: row.review_note,
    changed_fields: parseJson(row.changed_fields_json, []),
    before_snapshot: parseJson(row.before_snapshot_json, {}),
    after_snapshot: parseJson(row.after_snapshot_json, {}),
    created_at: row.created_at
  };
}

function feedbackRowToObject(row) {
  return {
    id: row.id,
    staging_event_id: row.staging_event_id,
    source_id: row.source_id,
    fault_agent: row.fault_agent,
    rejection_reason: row.rejection_reason,
    reviewer_name: row.reviewer_name,
    created_at: row.created_at
  };
}

function startOfUtcDayIso(daysAgo = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

function classifySourceHealth(source, latestRun, envState) {
  if (!source.is_active) {
    return {
      status: "inactive",
      reason_code: "inactive",
      reason: "Source is disabled and excluded from scheduled runs."
    };
  }

  if (source.adapter_key === "openai_listing_v1" && !envState.openai_api_key) {
    return {
      status: "error",
      reason_code: "env_missing_openai",
      reason: "OPENAI_API_KEY missing for AI extraction."
    };
  }

  if (source.adapter_key === "openai_listing_v1" && !envState.mcp_browser_url) {
    return {
      status: "error",
      reason_code: "env_missing_mcp",
      reason: "MCP_BROWSER_URL missing for browser automation."
    };
  }

  if (!source.last_polled_at) {
    return {
      status: "warning",
      reason_code: "not_run_yet",
      reason: "Source has not run yet."
    };
  }

  if (source.last_run_status === "failed") {
    const errorMessage = source.last_run_error || latestRun?.error_message || "Unknown error";
    if (String(errorMessage).toLowerCase().includes("timed out")) {
      return {
        status: "error",
        reason_code: "timeout",
        reason: `Last run timed out: ${errorMessage}`
      };
    }
    if (String(errorMessage).toLowerCase().includes("invalid json")) {
      return {
        status: "error",
        reason_code: "parse_failed",
        reason: `Model output parsing failed: ${errorMessage}`
      };
    }
    return {
      status: "error",
      reason_code: "run_failed",
      reason: `Last run failed: ${errorMessage}`
    };
  }

  return {
    status: "healthy",
    reason_code: "ok",
    reason: "Source is active and last run succeeded."
  };
}

export function createRepository(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      source_domain TEXT,
      source_type TEXT NOT NULL,
      listing_url TEXT,
      api_base_url TEXT,
      ics_url TEXT,
      adapter_key TEXT NOT NULL,
      poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
      is_active INTEGER NOT NULL DEFAULT 1,
      attribution_label TEXT,
      notes TEXT,
      adapter_config_json TEXT NOT NULL DEFAULT '{}',
      last_polled_at TEXT,
      next_run_at TEXT,
      last_run_status TEXT,
      last_run_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_candidates (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      external_event_id TEXT,
      event_url TEXT NOT NULL,
      title_hint TEXT,
      fingerprint TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      raw_payload_json TEXT,
      UNIQUE(source_id, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS events_staging (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_candidate_id TEXT,
      external_event_id TEXT,
      title TEXT,
      organizational_sponsor TEXT,
      event_type_categories_json TEXT NOT NULL DEFAULT '[]',
      start_datetime TEXT,
      end_datetime TEXT,
      location_type TEXT,
      location_or_address TEXT,
      room_number TEXT,
      event_link TEXT,
      short_description TEXT,
      extended_description TEXT,
      artwork_url TEXT,
      source_name TEXT,
      source_domain TEXT,
      source_listing_url TEXT,
      source_event_url TEXT,
      is_duplicate INTEGER,
      duplicate_match_url TEXT,
      duplicate_reason TEXT,
      confidence REAL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      ai_baseline_payload_json TEXT,
      extraction_metadata_json TEXT NOT NULL DEFAULT '{}',
      reviewed_at TEXT,
      community_hub_payload_json TEXT NOT NULL DEFAULT '{}',
      raw_payload_json TEXT,
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, source_event_url)
    );

    CREATE TABLE IF NOT EXISTS community_hub_events (
      id TEXT PRIMARY KEY,
      title TEXT,
      start_datetime TEXT,
      end_datetime TEXT,
      location_or_address TEXT,
      short_description TEXT,
      extended_description TEXT,
      source_event_url TEXT,
      community_hub_url TEXT,
      raw_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      new_candidates INTEGER NOT NULL DEFAULT 0,
      upserted_events INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      summary_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS staging_event_reviews (
      id TEXT PRIMARY KEY,
      staging_event_id TEXT NOT NULL,
      review_action TEXT NOT NULL,
      reviewer_name TEXT,
      review_note TEXT,
      changed_fields_json TEXT NOT NULL DEFAULT '[]',
      before_snapshot_json TEXT NOT NULL DEFAULT '{}',
      after_snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_feedback (
      id TEXT PRIMARY KEY,
      staging_event_id TEXT NOT NULL,
      source_id TEXT,
      fault_agent TEXT NOT NULL,
      rejection_reason TEXT NOT NULL,
      reviewer_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sources_next_run_at ON sources(next_run_at);
    CREATE INDEX IF NOT EXISTS idx_event_candidates_source_id ON event_candidates(source_id);
    CREATE INDEX IF NOT EXISTS idx_events_staging_source_id ON events_staging(source_id);
    CREATE INDEX IF NOT EXISTS idx_source_runs_source_id ON source_runs(source_id);
    CREATE INDEX IF NOT EXISTS idx_staging_event_reviews_event_id ON staging_event_reviews(staging_event_id);
    CREATE INDEX IF NOT EXISTS idx_staging_event_reviews_created_at ON staging_event_reviews(created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent ON agent_feedback(fault_agent);
    CREATE INDEX IF NOT EXISTS idx_agent_feedback_created_at ON agent_feedback(created_at);
  `);

  // Additive migrations — safe to run on existing databases
  for (const sql of [
    `ALTER TABLE events_staging ADD COLUMN hyperlocal_scope TEXT`,
    `ALTER TABLE events_staging ADD COLUMN geographic_tags_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE events_staging ADD COLUMN ai_baseline_payload_json TEXT`,
    `ALTER TABLE events_staging ADD COLUMN extraction_metadata_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE events_staging ADD COLUMN reviewed_at TEXT`,
    `ALTER TABLE community_hub_events ADD COLUMN short_description TEXT`,
    `ALTER TABLE community_hub_events ADD COLUMN extended_description TEXT`
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — ignore
    }
  }

  const statements = {
    insertSource: db.prepare(`
      INSERT INTO sources (
        id, source_name, source_domain, source_type, listing_url, api_base_url, ics_url,
        adapter_key, poll_interval_minutes, is_active, attribution_label, notes,
        adapter_config_json, created_at, updated_at, next_run_at
      ) VALUES (
        @id, @source_name, @source_domain, @source_type, @listing_url, @api_base_url, @ics_url,
        @adapter_key, @poll_interval_minutes, @is_active, @attribution_label, @notes,
        @adapter_config_json, @created_at, @updated_at, @next_run_at
      )
    `),
    updateSource: db.prepare(`
      UPDATE sources
      SET source_name = @source_name,
          source_domain = @source_domain,
          source_type = @source_type,
          listing_url = @listing_url,
          api_base_url = @api_base_url,
          ics_url = @ics_url,
          adapter_key = @adapter_key,
          poll_interval_minutes = @poll_interval_minutes,
          is_active = @is_active,
          attribution_label = @attribution_label,
          notes = @notes,
          adapter_config_json = @adapter_config_json,
          updated_at = @updated_at
      WHERE id = @id
    `),
    getSource: db.prepare(`SELECT * FROM sources WHERE id = ?`),
    getDueSources: db.prepare(`
      SELECT * FROM sources
      WHERE is_active = 1
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY COALESCE(next_run_at, created_at) ASC
      LIMIT ?
    `),
    listSources: db.prepare(`SELECT * FROM sources ORDER BY source_name ASC`),
    listCandidates: db.prepare(`
      SELECT * FROM event_candidates
      WHERE (? IS NULL OR source_id = ?)
      ORDER BY last_seen_at DESC
      LIMIT ?
    `),
    listStaging: db.prepare(`
      SELECT * FROM events_staging
      WHERE (? IS NULL OR source_id = ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `),
    listHubEvents: db.prepare(`
      SELECT * FROM community_hub_events
      ORDER BY updated_at DESC
      LIMIT ?
    `),
    listRuns: db.prepare(`
      SELECT * FROM source_runs
      WHERE (? IS NULL OR source_id = ?)
      ORDER BY started_at DESC
      LIMIT ?
    `),
    findCandidateByFingerprint: db.prepare(`
      SELECT * FROM event_candidates
      WHERE source_id = ? AND fingerprint = ?
    `),
    insertCandidate: db.prepare(`
      INSERT INTO event_candidates (
        id, source_id, external_event_id, event_url, title_hint, fingerprint,
        discovered_at, last_seen_at, status, raw_payload_json
      ) VALUES (
        @id, @source_id, @external_event_id, @event_url, @title_hint, @fingerprint,
        @discovered_at, @last_seen_at, @status, @raw_payload_json
      )
    `),
    updateCandidate: db.prepare(`
      UPDATE event_candidates
      SET external_event_id = @external_event_id,
          event_url = @event_url,
          title_hint = @title_hint,
          last_seen_at = @last_seen_at,
          status = @status,
          raw_payload_json = @raw_payload_json
      WHERE id = @id
    `),
    findStagingBySourceUrl: db.prepare(`
      SELECT * FROM events_staging
      WHERE source_id = ? AND source_event_url = ?
    `),
    insertStaging: db.prepare(`
      INSERT INTO events_staging (
        id, source_id, source_candidate_id, external_event_id, title,
        organizational_sponsor, event_type_categories_json, start_datetime, end_datetime,
        location_type, location_or_address, room_number, event_link, short_description,
        extended_description, artwork_url, source_name, source_domain, source_listing_url,
        source_event_url, is_duplicate, duplicate_match_url, duplicate_reason, confidence,
        review_status, ai_baseline_payload_json, extraction_metadata_json, reviewed_at,
        hyperlocal_scope, geographic_tags_json,
        community_hub_payload_json, raw_payload_json, discovered_at, updated_at
      ) VALUES (
        @id, @source_id, @source_candidate_id, @external_event_id, @title,
        @organizational_sponsor, @event_type_categories_json, @start_datetime, @end_datetime,
        @location_type, @location_or_address, @room_number, @event_link, @short_description,
        @extended_description, @artwork_url, @source_name, @source_domain, @source_listing_url,
        @source_event_url, @is_duplicate, @duplicate_match_url, @duplicate_reason, @confidence,
        @review_status, @ai_baseline_payload_json, @extraction_metadata_json, @reviewed_at,
        @hyperlocal_scope, @geographic_tags_json,
        @community_hub_payload_json, @raw_payload_json, @discovered_at, @updated_at
      )
    `),
    updateStaging: db.prepare(`
      UPDATE events_staging
      SET source_candidate_id = @source_candidate_id,
          external_event_id = @external_event_id,
          title = @title,
          organizational_sponsor = @organizational_sponsor,
          event_type_categories_json = @event_type_categories_json,
          start_datetime = @start_datetime,
          end_datetime = @end_datetime,
          location_type = @location_type,
          location_or_address = @location_or_address,
          room_number = @room_number,
          event_link = @event_link,
          short_description = @short_description,
          extended_description = @extended_description,
          artwork_url = @artwork_url,
          source_name = @source_name,
          source_domain = @source_domain,
          source_listing_url = @source_listing_url,
          is_duplicate = @is_duplicate,
          duplicate_match_url = @duplicate_match_url,
          duplicate_reason = @duplicate_reason,
          confidence = @confidence,
          review_status = @review_status,
          ai_baseline_payload_json = @ai_baseline_payload_json,
          extraction_metadata_json = @extraction_metadata_json,
          reviewed_at = @reviewed_at,
          hyperlocal_scope = @hyperlocal_scope,
          geographic_tags_json = @geographic_tags_json,
          community_hub_payload_json = @community_hub_payload_json,
          raw_payload_json = @raw_payload_json,
          updated_at = @updated_at
      WHERE id = @id
    `),
    reviewUpdateStaging: db.prepare(`
      UPDATE events_staging
      SET title = @title,
          organizational_sponsor = @organizational_sponsor,
          start_datetime = @start_datetime,
          end_datetime = @end_datetime,
          location_type = @location_type,
          location_or_address = @location_or_address,
          room_number = @room_number,
          event_link = @event_link,
          short_description = @short_description,
          extended_description = @extended_description,
          artwork_url = @artwork_url,
          is_duplicate = @is_duplicate,
          duplicate_match_url = @duplicate_match_url,
          duplicate_reason = @duplicate_reason,
          review_status = @review_status,
          ai_baseline_payload_json = @ai_baseline_payload_json,
          community_hub_payload_json = @community_hub_payload_json,
          reviewed_at = @reviewed_at,
          updated_at = @updated_at
      WHERE id = @id
    `),
    insertHubEvent: db.prepare(`
      INSERT INTO community_hub_events (
        id, title, start_datetime, end_datetime, location_or_address, short_description,
        extended_description, source_event_url, community_hub_url, raw_payload_json, created_at, updated_at
      ) VALUES (
        @id, @title, @start_datetime, @end_datetime, @location_or_address, @short_description,
        @extended_description, @source_event_url, @community_hub_url, @raw_payload_json, @created_at, @updated_at
      )
    `),
    updateHubEventBySourceUrl: db.prepare(`
      UPDATE community_hub_events SET
        title = @title,
        start_datetime = @start_datetime,
        end_datetime = @end_datetime,
        location_or_address = @location_or_address,
        short_description = @short_description,
        extended_description = @extended_description,
        community_hub_url = @community_hub_url,
        raw_payload_json = @raw_payload_json,
        updated_at = @updated_at
      WHERE source_event_url = @source_event_url
    `),
    findHubBySourceUrl: db.prepare(`
      SELECT * FROM community_hub_events WHERE source_event_url = ?
    `),
    findStagingBySourceUrlAny: db.prepare(`
      SELECT * FROM events_staging WHERE source_event_url = ? LIMIT 1
    `),
    findHubByTitleAndStart: db.prepare(`
      SELECT * FROM community_hub_events WHERE title = ? AND start_datetime = ? LIMIT 1
    `),
    findStagingByTitleAndStart: db.prepare(`
      SELECT * FROM events_staging
      WHERE title = ? AND start_datetime = ? AND source_id != ?
      LIMIT 1
    `),
    insertRun: db.prepare(`
      INSERT INTO source_runs (
        id, source_id, started_at, status, new_candidates, upserted_events, summary_json
      ) VALUES (
        @id, @source_id, @started_at, @status, 0, 0, '{}'
      )
    `),
    finishRun: db.prepare(`
      UPDATE source_runs
      SET finished_at = @finished_at,
          status = @status,
          new_candidates = @new_candidates,
          upserted_events = @upserted_events,
          error_message = @error_message,
          summary_json = @summary_json
      WHERE id = @id
    `),
    markSourceAfterRun: db.prepare(`
      UPDATE sources
      SET last_polled_at = @last_polled_at,
          next_run_at = @next_run_at,
          last_run_status = @last_run_status,
          last_run_error = @last_run_error,
          updated_at = @updated_at
      WHERE id = @id
    `),
    listFingerprintsForSource: db.prepare(`SELECT fingerprint FROM event_candidates WHERE source_id = ?`),
    countTable: (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`),
    getStagingById: db.prepare(`SELECT * FROM events_staging WHERE id = ?`),
    insertReviewEntry: db.prepare(`
      INSERT INTO staging_event_reviews (
        id, staging_event_id, review_action, reviewer_name, review_note,
        changed_fields_json, before_snapshot_json, after_snapshot_json, created_at
      ) VALUES (
        @id, @staging_event_id, @review_action, @reviewer_name, @review_note,
        @changed_fields_json, @before_snapshot_json, @after_snapshot_json, @created_at
      )
    `),
    listRecentReviews: db.prepare(`
      SELECT * FROM staging_event_reviews
      ORDER BY created_at DESC
      LIMIT ?
    `),
    insertAgentFeedback: db.prepare(`
      INSERT INTO agent_feedback (
        id, staging_event_id, source_id, fault_agent, rejection_reason, reviewer_name, created_at
      ) VALUES (
        @id, @staging_event_id, @source_id, @fault_agent, @rejection_reason, @reviewer_name, @created_at
      )
    `),
    listAgentFeedbackByAgent: db.prepare(`
      SELECT * FROM agent_feedback
      WHERE fault_agent = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
  };

  function normalizeSourceInput(input) {
    const now = nowIso();
    const adapterKey =
      input.adapter_key ||
      (input.source_type === "api"
        ? "localist_v1"
        : input.source_type === "ics"
          ? "ics_v1"
          : "browser_listing_v1");

    return {
      id: input.source_id || input.id || makeId("src"),
      source_name: input.source_name,
      source_domain: input.source_domain || null,
      source_type: input.source_type,
      listing_url: input.listing_url || null,
      api_base_url: input.api_base_url || null,
      ics_url: input.ics_url || null,
      adapter_key: adapterKey,
      poll_interval_minutes: Number(input.poll_interval_minutes || 360),
      is_active: input.is_active === false ? 0 : 1,
      attribution_label: input.attribution_label || null,
      notes: input.notes || null,
      adapter_config_json: JSON.stringify(input.adapter_config || {}),
      created_at: now,
      updated_at: now,
      next_run_at: now
    };
  }

  return {
    listSources() {
      return statements.listSources.all().map(sourceRowToObject);
    },

    getSource(id) {
      return sourceRowToObject(statements.getSource.get(id));
    },

    createSource(input) {
      const row = normalizeSourceInput(input);
      statements.insertSource.run(row);
      return this.getSource(row.id);
    },

    updateSource(id, input) {
      const current = this.getSource(id);
      if (!current) {
        return null;
      }

      const row = {
        id,
        source_name: input.source_name ?? current.source_name,
        source_domain: input.source_domain ?? current.source_domain,
        source_type: input.source_type ?? current.source_type,
        listing_url: input.listing_url ?? current.listing_url,
        api_base_url: input.api_base_url ?? current.api_base_url,
        ics_url: input.ics_url ?? current.ics_url,
        adapter_key: input.adapter_key ?? current.adapter_key,
        poll_interval_minutes: Number(
          input.poll_interval_minutes ?? current.poll_interval_minutes
        ),
        is_active:
          input.is_active === undefined ? (current.is_active ? 1 : 0) : input.is_active ? 1 : 0,
        attribution_label: input.attribution_label ?? current.attribution_label,
        notes: input.notes ?? current.notes,
        adapter_config_json: JSON.stringify(input.adapter_config ?? current.adapter_config ?? {}),
        updated_at: nowIso()
      };

      statements.updateSource.run(row);
      return this.getSource(id);
    },

    getDueSources(limit = 3) {
      return statements.getDueSources.all(nowIso(), limit).map(sourceRowToObject);
    },

    listCandidates({ sourceId = null, limit = 100 } = {}) {
      return statements.listCandidates
        .all(sourceId, sourceId, limit)
        .map(candidateRowToObject);
    },

    listStaging({ sourceId = null, limit = 100 } = {}) {
      return statements.listStaging.all(sourceId, sourceId, limit).map(stagingRowToObject);
    },

    listHubEvents(limit = 100) {
      return statements.listHubEvents.all(limit).map((row) => ({
        ...row,
        raw_payload: parseJson(row.raw_payload_json, null)
      }));
    },

    listRuns({ sourceId = null, limit = 50 } = {}) {
      return statements.listRuns.all(sourceId, sourceId, limit).map(runRowToObject);
    },

    upsertCandidate(sourceId, candidate) {
      const now = nowIso();
      const existing = statements.findCandidateByFingerprint.get(sourceId, candidate.fingerprint);
      if (existing) {
        statements.updateCandidate.run({
          id: existing.id,
          external_event_id: candidate.external_event_id || null,
          event_url: candidate.event_url,
          title_hint: candidate.title_hint || null,
          last_seen_at: now,
          status: "seen",
          raw_payload_json: JSON.stringify(candidate.raw_payload || null)
        });
        return {
          inserted: false,
          record: candidateRowToObject({
            ...existing,
            external_event_id: candidate.external_event_id || null,
            event_url: candidate.event_url,
            title_hint: candidate.title_hint || null,
            last_seen_at: now,
            status: "seen",
            raw_payload_json: JSON.stringify(candidate.raw_payload || null)
          })
        };
      }

      const row = {
        id: makeId("cand"),
        source_id: sourceId,
        external_event_id: candidate.external_event_id || null,
        event_url: candidate.event_url,
        title_hint: candidate.title_hint || null,
        fingerprint: candidate.fingerprint,
        discovered_at: now,
        last_seen_at: now,
        status: "new",
        raw_payload_json: JSON.stringify(candidate.raw_payload || null)
      };
      statements.insertCandidate.run(row);
      return { inserted: true, record: candidateRowToObject(row) };
    },

    upsertStagingEvent(sourceId, sourceCandidateId, event) {
      const now = nowIso();
      const rawUrl = (event.source_event_url || "").trim();
      const seUrl = (normalizeCanonicalEventUrl(rawUrl) || rawUrl) || null;
      let existing = seUrl ? statements.findStagingBySourceUrl.get(sourceId, seUrl) : null;
      if (!existing && rawUrl && rawUrl !== seUrl) {
        existing = statements.findStagingBySourceUrl.get(sourceId, rawUrl);
      }
      const row = {
        id: existing?.id || makeId("evt"),
        source_id: sourceId,
        source_candidate_id: sourceCandidateId || null,
        external_event_id: event.external_event_id || null,
        title: event.title || null,
        organizational_sponsor: event.organizational_sponsor || null,
        event_type_categories_json: JSON.stringify(event.event_type_categories || []),
        start_datetime: event.start_datetime || null,
        end_datetime: event.end_datetime || null,
        location_type: event.location_type || null,
        location_or_address: event.location_or_address || null,
        room_number: event.room_number || null,
        event_link: event.event_link || null,
        short_description: event.short_description || null,
        extended_description: event.extended_description || null,
        artwork_url: event.artwork_url || null,
        source_name: event.source_name || null,
        source_domain: event.source_domain || null,
        source_listing_url: event.source_listing_url || null,
        source_event_url: seUrl || rawUrl,
        is_duplicate:
          event.is_duplicate === null || event.is_duplicate === undefined
            ? null
            : event.is_duplicate
              ? 1
              : 0,
        duplicate_match_url: event.duplicate_match_url || null,
        duplicate_reason: event.duplicate_reason || null,
        confidence: event.confidence ?? null,
        review_status: event.review_status || "pending",
        ai_baseline_payload_json: existing?.ai_baseline_payload_json || null,
        extraction_metadata_json: JSON.stringify(
          event.extraction_metadata ?? parseJson(existing?.extraction_metadata_json, {})
        ),
        reviewed_at: existing?.reviewed_at || null,
        hyperlocal_scope: event.hyperlocal_scope || null,
        geographic_tags_json: JSON.stringify(event.geographic_tags || []),
        community_hub_payload_json: JSON.stringify(event.community_hub_payload || {}),
        raw_payload_json: JSON.stringify(event.raw_payload || null),
        discovered_at: existing?.discovered_at || now,
        updated_at: now
      };

      if (existing) {
        statements.updateStaging.run(row);
        return { inserted: false, record: stagingRowToObject(row) };
      }

      statements.insertStaging.run(row);
      return { inserted: true, record: stagingRowToObject(row) };
    },

    reviewStagingEvent(id, input = {}, meta = {}) {
      const current = this.getStagingById(id);
      if (!current) {
        return null;
      }

      const before = buildReviewSnapshot(current);
      const next = {
        ...current
      };

      for (const field of [
        "title",
        "organizational_sponsor",
        "start_datetime",
        "end_datetime",
        "location_type",
        "location_or_address",
        "room_number",
        "event_link",
        "short_description",
        "extended_description",
        "artwork_url"
      ]) {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
          next[field] = input[field] ?? null;
        }
      }

      if (Object.prototype.hasOwnProperty.call(input, "is_duplicate")) {
        next.is_duplicate =
          input.is_duplicate === null || input.is_duplicate === undefined
            ? null
            : Boolean(input.is_duplicate);
      }
      if (Object.prototype.hasOwnProperty.call(input, "duplicate_match_url")) {
        next.duplicate_match_url = input.duplicate_match_url || null;
      }
      if (Object.prototype.hasOwnProperty.call(input, "duplicate_reason")) {
        next.duplicate_reason = input.duplicate_reason || null;
      }
      if (Object.prototype.hasOwnProperty.call(input, "review_status")) {
        next.review_status = input.review_status || current.review_status || "pending";
      }

      if (next.is_duplicate !== true) {
        next.duplicate_match_url = Object.prototype.hasOwnProperty.call(input, "duplicate_match_url")
          ? next.duplicate_match_url || null
          : null;
        next.duplicate_reason = Object.prototype.hasOwnProperty.call(input, "duplicate_reason")
          ? next.duplicate_reason || null
          : next.is_duplicate === false
            ? "review_override_unique"
            : null;
      }

      const after = buildReviewSnapshot(next);
      const changedFields = diffReviewFields(before, after);
      const hasReviewMeta = Boolean(meta.reviewer_name || meta.review_note);

      if (!changedFields.length && !hasReviewMeta) {
        return current;
      }

      const baseline = current.ai_baseline_payload || before;
      const reviewedAt = current.reviewed_at || nowIso();
      const action = changedFields.some((field) =>
        ["is_duplicate", "duplicate_match_url", "duplicate_reason"].includes(field)
      )
        ? "duplicate_override"
        : changedFields.every((field) => field === "review_status")
          ? "status_change"
          : "field_edit";

      statements.reviewUpdateStaging.run({
        id: current.id,
        title: next.title || null,
        organizational_sponsor: next.organizational_sponsor || null,
        start_datetime: next.start_datetime || null,
        end_datetime: next.end_datetime || null,
        location_type: next.location_type || null,
        location_or_address: next.location_or_address || null,
        room_number: next.room_number || null,
        event_link: next.event_link || null,
        short_description: next.short_description || null,
        extended_description: next.extended_description || null,
        artwork_url: next.artwork_url || null,
        is_duplicate:
          next.is_duplicate === null || next.is_duplicate === undefined
            ? null
            : next.is_duplicate
              ? 1
              : 0,
        duplicate_match_url: next.duplicate_match_url || null,
        duplicate_reason: next.duplicate_reason || null,
        review_status: next.review_status || "pending",
        ai_baseline_payload_json: JSON.stringify(baseline),
        community_hub_payload_json: JSON.stringify(
          syncCommunityHubPayload(current.community_hub_payload, after)
        ),
        reviewed_at: reviewedAt,
        updated_at: nowIso()
      });

      statements.insertReviewEntry.run({
        id: makeId("rev"),
        staging_event_id: current.id,
        review_action: action,
        reviewer_name: meta.reviewer_name || null,
        review_note: meta.review_note || null,
        changed_fields_json: JSON.stringify(changedFields),
        before_snapshot_json: JSON.stringify(before),
        after_snapshot_json: JSON.stringify(after),
        created_at: nowIso()
      });

      return this.getStagingById(id);
    },

    addCommunityHubEvent(input) {
      const now = nowIso();
      const row = {
        id: input.id || makeId("hub"),
        title: input.title || null,
        start_datetime: input.start_datetime || null,
        end_datetime: input.end_datetime || null,
        location_or_address: input.location_or_address || null,
        short_description: input.short_description || null,
        extended_description: input.extended_description || null,
        source_event_url: input.source_event_url || null,
        community_hub_url: input.community_hub_url || null,
        raw_payload_json: JSON.stringify(input.raw_payload || null),
        created_at: now,
        updated_at: now
      };
      statements.insertHubEvent.run(row);
      return row;
    },

    upsertCommunityHubEvent(input) {
      const raw = input.source_event_url?.trim();
      if (!raw) {
        throw new Error("upsertCommunityHubEvent requires source_event_url");
      }
      const canonical = normalizeCanonicalEventUrl(raw) || raw;
      let existing = statements.findHubBySourceUrl.get(canonical);
      if (!existing && raw !== canonical) {
        existing = statements.findHubBySourceUrl.get(raw);
      }
      const now = nowIso();
      const hubUrl = (input.community_hub_url || "").trim() || canonical;
      const incShort =
        typeof input.short_description === "string" ? input.short_description.trim() : "";
      const incExt =
        typeof input.extended_description === "string" ? input.extended_description.trim() : "";
      const mergeDesc = (incoming, prior) => (incoming ? incoming : prior || null);
      const payload = {
        title: input.title || null,
        start_datetime: input.start_datetime || null,
        end_datetime: input.end_datetime || null,
        location_or_address: input.location_or_address || null,
        short_description: mergeDesc(incShort, existing?.short_description),
        extended_description: mergeDesc(incExt, existing?.extended_description),
        source_event_url: canonical,
        community_hub_url: normalizeCanonicalEventUrl(hubUrl) || hubUrl,
        raw_payload_json: JSON.stringify(input.raw_payload || { snapshot: true }),
        updated_at: now
      };
      if (existing) {
        statements.updateHubEventBySourceUrl.run({
          ...payload,
          source_event_url: existing.source_event_url
        });
        return { inserted: false, record: statements.findHubBySourceUrl.get(existing.source_event_url) };
      }
      const row = {
        id: makeId("hub"),
        ...payload,
        created_at: now
      };
      statements.insertHubEvent.run({
        id: row.id,
        title: row.title,
        start_datetime: row.start_datetime,
        end_datetime: row.end_datetime,
        location_or_address: row.location_or_address,
        short_description: row.short_description,
        extended_description: row.extended_description,
        source_event_url: row.source_event_url,
        community_hub_url: row.community_hub_url,
        raw_payload_json: row.raw_payload_json,
        created_at: row.created_at,
        updated_at: row.updated_at
      });
      return { inserted: true, record: row };
    },

    findDuplicateMatch(event, sourceId) {
      const resolveHubByUrl = (url) => {
        if (!url) return null;
        const u = String(url).trim();
        let row = statements.findHubBySourceUrl.get(u);
        if (row) return row;
        const norm = normalizeCanonicalEventUrl(u);
        if (norm && norm !== u) {
          row = statements.findHubBySourceUrl.get(norm);
          if (row) return row;
        }
        if (!norm) return null;
        const allHub = db.prepare(`SELECT * FROM community_hub_events`).all();
        return allHub.find((r) => normalizeCanonicalEventUrl(r.source_event_url) === norm) || null;
      };

      const resolveStagingByUrl = (url) => {
        if (!url) return null;
        const u = String(url).trim();
        let row = statements.findStagingBySourceUrlAny.get(u);
        if (row && row.source_id !== sourceId) return row;
        const norm = normalizeCanonicalEventUrl(u);
        if (norm && norm !== u) {
          row = statements.findStagingBySourceUrlAny.get(norm);
          if (row && row.source_id !== sourceId) return row;
        }
        if (!norm) return null;
        const rows = db.prepare(`SELECT * FROM events_staging WHERE source_id != ?`).all(sourceId);
        return rows.find((r) => normalizeCanonicalEventUrl(r.source_event_url) === norm) || null;
      };

      if (event.source_event_url) {
        const hubMatch = resolveHubByUrl(event.source_event_url);
        if (hubMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: hubMatch.community_hub_url || hubMatch.source_event_url,
            duplicate_reason: "exact_source_event_url_in_community_hub"
          };
        }

        const stagingUrlMatch = resolveStagingByUrl(event.source_event_url);
        if (stagingUrlMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: stagingUrlMatch.source_event_url,
            duplicate_reason: "exact_source_event_url_in_staging"
          };
        }
      }

      if (event.title && event.start_datetime) {
        const titleTrim = String(event.title).trim();
        const hubTitleMatch = statements.findHubByTitleAndStart.get(titleTrim, event.start_datetime);
        if (hubTitleMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: hubTitleMatch.community_hub_url || hubTitleMatch.source_event_url,
            duplicate_reason: "exact_title_and_start_in_community_hub"
          };
        }

        const stagingTitleMatch = statements.findStagingByTitleAndStart.get(
          titleTrim,
          event.start_datetime,
          sourceId
        );
        if (stagingTitleMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: stagingTitleMatch.source_event_url,
            duplicate_reason: "exact_title_and_start_in_staging"
          };
        }
      }

      const eventKey = eventTitleKey(event.title);
      if (eventKey && event.start_datetime) {
        const hubRows = db.prepare(`SELECT * FROM community_hub_events`).all();
        const hubFuzzy = hubRows.find((h) => {
          return (
            eventTitleKey(h.title) === eventKey &&
            h.start_datetime === event.start_datetime &&
            String(h.location_or_address || "").trim() === String(event.location_or_address || "").trim()
          );
        });
        if (hubFuzzy) {
          return {
            is_duplicate: true,
            duplicate_match_url: hubFuzzy.community_hub_url || hubFuzzy.source_event_url,
            duplicate_reason: "fuzzy_title_start_location_in_community_hub"
          };
        }

        const nearby = this.listStaging({ sourceId: null, limit: 200 });
        const fuzzyMatch = nearby.find((candidate) => {
          if (candidate.source_id === sourceId) {
            return false;
          }
          return (
            eventTitleKey(candidate.title) === eventKey &&
            candidate.start_datetime === event.start_datetime &&
            candidate.location_or_address === event.location_or_address
          );
        });

        if (fuzzyMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: fuzzyMatch.source_event_url,
            duplicate_reason: "fuzzy_title_start_location_in_staging"
          };
        }
      }

      return {
        is_duplicate: false,
        duplicate_match_url: null,
        duplicate_reason: null
      };
    },

    beginRun(sourceId) {
      const row = {
        id: makeId("run"),
        source_id: sourceId,
        started_at: nowIso(),
        status: "running"
      };
      statements.insertRun.run(row);
      return row.id;
    },

    finishRun(runId, details) {
      statements.finishRun.run({
        id: runId,
        finished_at: nowIso(),
        status: details.status,
        new_candidates: details.new_candidates || 0,
        upserted_events: details.upserted_events || 0,
        error_message: details.error_message || null,
        summary_json: JSON.stringify(details.summary || {})
      });
    },

    markSourceRunResult(sourceId, status, errorMessage, pollIntervalMinutes) {
      const now = nowIso();
      statements.markSourceAfterRun.run({
        id: sourceId,
        last_polled_at: now,
        next_run_at: addMinutes(now, pollIntervalMinutes),
        last_run_status: status,
        last_run_error: errorMessage || null,
        updated_at: now
      });
    },

    seedSourcesIfEmpty(seedSources) {
      // Insert-if-not-exists by source_id — safe to run on every boot,
      // adds new sources from the seed file without overwriting existing rows.
      let inserted = 0;
      for (const source of seedSources) {
        const id = source.source_id || source.id;
        if (id && this.getSource(id)) {
          continue; // Already exists — skip
        }
        this.createSource(source);
        inserted += 1;
      }
      return inserted;
    },

    /** Force-apply seed definitions: update existing sources, insert new ones. */
    applySeedSources(seedSources) {
      let inserted = 0, updated = 0;
      for (const source of seedSources) {
        const id = source.source_id || source.id;
        if (!id) continue;
        if (this.getSource(id)) {
          this.updateSource(id, source);
          updated += 1;
        } else {
          this.createSource(source);
          inserted += 1;
        }
      }
      return { inserted, updated };
    },

    /** Per-agent metrics computed from DB state. */
    getAgentMetrics() {
      const candidates = db.prepare(`SELECT source_id, COUNT(*) as cnt FROM event_candidates GROUP BY source_id`).all();
      const staging    = db.prepare(`SELECT source_id, COUNT(*) as total,
        SUM(CASE WHEN is_duplicate=1 THEN 1 ELSE 0 END) as duplicates,
        SUM(CASE WHEN review_status='approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN review_status='pending' AND (is_duplicate IS NULL OR is_duplicate=0) THEN 1 ELSE 0 END) as pending
        FROM events_staging GROUP BY source_id`).all();
      const scopes     = db.prepare(`SELECT hyperlocal_scope, COUNT(*) as cnt FROM events_staging WHERE hyperlocal_scope IS NOT NULL GROUP BY hyperlocal_scope`).all();
      const totalCandidates = db.prepare(`SELECT COUNT(*) as n FROM event_candidates`).get().n;
      const totalStaged     = db.prepare(`SELECT COUNT(*) as n FROM events_staging`).get().n;
      const totalDups       = db.prepare(`SELECT COUNT(*) as n FROM events_staging WHERE is_duplicate=1`).get().n;
      const totalApproved   = db.prepare(`SELECT COUNT(*) as n FROM events_staging WHERE review_status='approved'`).get().n;
      const totalPending    = db.prepare(`SELECT COUNT(*) as n FROM events_staging WHERE review_status='pending' AND (is_duplicate IS NULL OR is_duplicate=0)`).get().n;
      const recentRuns      = db.prepare(`SELECT source_id, status, new_candidates, upserted_events, started_at, finished_at FROM source_runs ORDER BY started_at DESC LIMIT 50`).all();
      const reviewedRows    = db.prepare(`SELECT * FROM events_staging WHERE reviewed_at IS NOT NULL ORDER BY reviewed_at DESC`).all();
      const sourceRows = statements.listSources.all().map(sourceRowToObject);
      const reviewEvents = reviewedRows.map(stagingRowToObject);
      const recentReviews = statements.listRecentReviews.all(12).map(reviewRowToObject);
      const fieldStats = Object.fromEntries(
        ACCURACY_COMPARISON_FIELDS.map((field) => [
          field,
          { field, reviewed_count: 0, changed_count: 0, unchanged_count: 0, exact_match_rate: 0, change_rate: 0 }
        ])
      );
      let comparableReviewed = 0;
      let correctedEvents = 0;
      let changedFieldTotal = 0;
      let duplicateOverrides = 0;
      const bySource = {};

      for (const event of reviewEvents) {
        const baseline = event.ai_baseline_payload;
        const sourceName = event.source_name || event.source_id || "Unknown";
        if (!bySource[sourceName]) {
          bySource[sourceName] = {
            source_name: sourceName,
            reviewed_count: 0,
            comparable_count: 0,
            corrected_count: 0,
            approved_count: 0,
            correction_rate: 0
          };
        }
        bySource[sourceName].reviewed_count += 1;
        if (event.review_status === "approved") {
          bySource[sourceName].approved_count += 1;
        }

        if (!baseline) {
          continue;
        }

        comparableReviewed += 1;
        bySource[sourceName].comparable_count += 1;
        const changed = ACCURACY_COMPARISON_FIELDS.filter((field) => {
          return JSON.stringify(baseline?.[field] ?? null) !== JSON.stringify(event?.[field] ?? null);
        });
        const changedSet = new Set(changed);
        if (changed.length > 0) {
          correctedEvents += 1;
          bySource[sourceName].corrected_count += 1;
        }
        if (
          changedSet.has("is_duplicate") ||
          changedSet.has("duplicate_match_url") ||
          changedSet.has("duplicate_reason")
        ) {
          duplicateOverrides += 1;
        }
        changedFieldTotal += changed.length;

        for (const field of ACCURACY_COMPARISON_FIELDS) {
          fieldStats[field].reviewed_count += 1;
          if (changedSet.has(field)) {
            fieldStats[field].changed_count += 1;
          } else {
            fieldStats[field].unchanged_count += 1;
          }
        }
      }

      const fieldAccuracy = Object.values(fieldStats)
        .map((stat) => {
          const reviewedCount = stat.reviewed_count;
          const exactMatchRate =
            reviewedCount > 0
              ? +(((reviewedCount - stat.changed_count) / reviewedCount) * 100).toFixed(1)
              : 0;
          const changeRate =
            reviewedCount > 0 ? +((stat.changed_count / reviewedCount) * 100).toFixed(1) : 0;
          return {
            ...stat,
            exact_match_rate: exactMatchRate,
            change_rate: changeRate
          };
        })
        .sort((a, b) => b.change_rate - a.change_rate);

      const sourceAccuracy = Object.values(bySource)
        .map((row) => ({
          ...row,
          correction_rate:
            row.comparable_count > 0 ? +((row.corrected_count / row.comparable_count) * 100).toFixed(1) : 0
        }))
        .sort((a, b) => b.reviewed_count - a.reviewed_count);

      const envState = {
        openai_api_key: Boolean(process.env.OPENAI_API_KEY?.trim()),
        mcp_browser_url: Boolean(
          (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim()
        )
      };
      const latestRunsBySource = Object.fromEntries(
        recentRuns.map((run) => [run.source_id, run])
      );
      const sourceHealth = sourceRows
        .map((source) => ({
          source_id: source.id,
          source_name: source.source_name,
          ...classifySourceHealth(source, latestRunsBySource[source.id], envState),
          last_polled_at: source.last_polled_at || null,
          last_run_status: source.last_run_status || null
        }))
        .sort((a, b) => a.source_name.localeCompare(b.source_name));
      const sourceHealthCounts = sourceHealth.reduce(
        (acc, row) => {
          if (row.status === "healthy") acc.healthy += 1;
          else if (row.status === "warning") acc.warning += 1;
          else if (row.status === "error") acc.error += 1;
          else acc.inactive += 1;
          return acc;
        },
        { healthy: 0, warning: 0, error: 0, inactive: 0 }
      );
      const historyDays = 14;
      const historyFromIso = startOfUtcDayIso(historyDays - 1);
      const reviewHistoryRows = db.prepare(`
        SELECT substr(reviewed_at, 1, 10) AS day,
               COUNT(*) AS reviewed_count
        FROM events_staging
        WHERE reviewed_at IS NOT NULL
          AND reviewed_at >= ?
        GROUP BY substr(reviewed_at, 1, 10)
        ORDER BY day ASC
      `).all(historyFromIso);
      const correctionHistoryRows = db.prepare(`
        SELECT substr(s.reviewed_at, 1, 10) AS day,
               COUNT(*) AS corrected_count
        FROM events_staging s
        WHERE s.reviewed_at IS NOT NULL
          AND s.reviewed_at >= ?
          AND s.ai_baseline_payload_json IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM staging_event_reviews r
            WHERE r.staging_event_id = s.id
              AND r.changed_fields_json != '[]'
          )
        GROUP BY substr(s.reviewed_at, 1, 10)
        ORDER BY day ASC
      `).all(historyFromIso);
      const runsHistoryRows = db.prepare(`
        SELECT substr(started_at, 1, 10) AS day,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs
        FROM source_runs
        WHERE started_at >= ?
        GROUP BY substr(started_at, 1, 10)
        ORDER BY day ASC
      `).all(historyFromIso);
      const historyMap = new Map();
      const ensureDay = (day) => {
        if (!historyMap.has(day)) {
          historyMap.set(day, {
            day,
            reviewed_count: 0,
            corrected_count: 0,
            correction_rate: 0,
            exact_match_rate: 0,
            successful_runs: 0,
            failed_runs: 0
          });
        }
        return historyMap.get(day);
      };
      for (let i = historyDays - 1; i >= 0; i -= 1) {
        const day = startOfUtcDayIso(i).slice(0, 10);
        ensureDay(day);
      }
      for (const row of reviewHistoryRows) {
        ensureDay(row.day).reviewed_count = Number(row.reviewed_count || 0);
      }
      for (const row of correctionHistoryRows) {
        ensureDay(row.day).corrected_count = Number(row.corrected_count || 0);
      }
      for (const row of runsHistoryRows) {
        const day = ensureDay(row.day);
        day.successful_runs = Number(row.success_runs || 0);
        day.failed_runs = Number(row.failed_runs || 0);
      }
      const historySeries = [...historyMap.values()].map((entry) => {
        const reviewed = entry.reviewed_count || 0;
        const corrected = entry.corrected_count || 0;
        const correctionRate = reviewed > 0 ? +((corrected / reviewed) * 100).toFixed(1) : 0;
        const exactMatchRate = reviewed > 0 ? +(((reviewed - corrected) / reviewed) * 100).toFixed(1) : 0;
        return {
          ...entry,
          correction_rate: correctionRate,
          exact_match_rate: exactMatchRate
        };
      });
      const failureGroups = sourceHealth
        .filter((row) => row.status === "error" || row.status === "warning")
        .reduce((acc, row) => {
          const key = row.reason_code || "unknown";
          if (!acc[key]) {
            acc[key] = {
              reason_code: key,
              status: row.status,
              count: 0,
              sources: [],
              reason: row.reason
            };
          }
          acc[key].count += 1;
          acc[key].sources.push({
            source_id: row.source_id,
            source_name: row.source_name,
            reason: row.reason,
            last_run_status: row.last_run_status
          });
          return acc;
        }, {});
      const failureSummary = Object.values(failureGroups).sort((a, b) => b.count - a.count);
      const learningRows = db.prepare(`
        SELECT fault_agent,
               rejection_reason,
               COUNT(*) AS count
        FROM agent_feedback
        GROUP BY fault_agent, rejection_reason
        ORDER BY count DESC
        LIMIT 40
      `).all();
      const learningByAgent = learningRows.reduce((acc, row) => {
        const key = row.fault_agent || "other";
        if (!acc[key]) acc[key] = [];
        acc[key].push({
          rejection_reason: row.rejection_reason || "",
          count: Number(row.count || 0)
        });
        return acc;
      }, {});
      const learningFeedback = Object.entries(learningByAgent)
        .map(([fault_agent, reasons]) => ({
          fault_agent,
          top_reasons: reasons.sort((a, b) => b.count - a.count).slice(0, 5)
        }))
        .sort((a, b) => {
          const aCount = a.top_reasons.reduce((sum, row) => sum + row.count, 0);
          const bCount = b.top_reasons.reduce((sum, row) => sum + row.count, 0);
          return bCount - aCount;
        });

      return {
        agent1: { total_candidates: totalCandidates, by_source: candidates },
        agent2: { total_staged: totalStaged, by_source: staging },
        agent3: { scope_distribution: scopes },
        agent4: { total_duplicates: totalDups, duplicate_rate: totalStaged > 0 ? +(totalDups / totalStaged * 100).toFixed(1) : 0 },
        agent5: { total_approved: totalApproved, total_pending: totalPending, approval_rate: totalStaged > 0 ? +(totalApproved / totalStaged * 100).toFixed(1) : 0 },
        accuracy: {
          total_reviewed: reviewEvents.length,
          comparable_reviewed: comparableReviewed,
          baseline_coverage:
            reviewEvents.length > 0 ? +((comparableReviewed / reviewEvents.length) * 100).toFixed(1) : 0,
          reviewed_with_corrections: correctedEvents,
          correction_rate:
            comparableReviewed > 0 ? +((correctedEvents / comparableReviewed) * 100).toFixed(1) : 0,
          exact_match_rate:
            comparableReviewed > 0 ? +(((comparableReviewed - correctedEvents) / comparableReviewed) * 100).toFixed(1) : 0,
          average_changed_fields:
            comparableReviewed > 0 ? +(changedFieldTotal / comparableReviewed).toFixed(2) : 0,
          duplicate_overrides: duplicateOverrides,
          field_accuracy: fieldAccuracy,
          by_source: sourceAccuracy,
          recent_reviews: recentReviews
        },
        source_health: {
          env: envState,
          counts: sourceHealthCounts,
          by_source: sourceHealth
        },
        history: {
          days: historyDays,
          by_day: historySeries
        },
        failures: {
          groups: failureSummary
        },
        learning_feedback: {
          by_agent: learningFeedback
        },
        recent_runs: recentRuns
      };
    },

    getStagingById(id) {
      const row = statements.getStagingById.get(id);
      return row ? stagingRowToObject(row) : null;
    },

    updateStagingReviewStatus(id, status) {
      return this.reviewStagingEvent(id, { review_status: status });
    },

    getKnownFingerprints(sourceId) {
      const rows = statements.listFingerprintsForSource.all(sourceId);
      return new Set(rows.map(r => r.fingerprint));
    },

    patchStagingFields(id, fields) {
      return this.reviewStagingEvent(id, fields);
    },

    getSummaryCounts() {
      return {
        sources: statements.countTable("sources").get().count,
        event_candidates: statements.countTable("event_candidates").get().count,
        events_staging: statements.countTable("events_staging").get().count,
        community_hub_events: statements.countTable("community_hub_events").get().count,
        source_runs: statements.countTable("source_runs").get().count
      };
    },

    /**
     * Compact JSON snapshot for pilot research exports (feasibility / accuracy / throughput).
     * Safe to call from GET /api/research/snapshot for lab notebooks or IRB appendices.
     */
    getResearchSnapshot() {
      const counts = this.getSummaryCounts();
      const byReview = db
        .prepare(
          `SELECT review_status, COUNT(*) AS n FROM events_staging GROUP BY review_status ORDER BY n DESC`
        )
        .all();
      const byQa = db
        .prepare(
          `SELECT COALESCE(json_extract(extraction_metadata_json, '$.qa_status'), 'unknown') AS qa_status, COUNT(*) AS n
           FROM events_staging GROUP BY qa_status ORDER BY n DESC`
        )
        .all();
      const pastAutoRejected = db
        .prepare(
          `SELECT COUNT(*) AS n FROM events_staging
           WHERE json_extract(extraction_metadata_json, '$.auto_reject_reason') = 'event_start_in_past'`
        )
        .get().n;
      const dupStaging = db
        .prepare(`SELECT COUNT(*) AS n FROM events_staging WHERE is_duplicate = 1`)
        .get().n;
      const pendingHuman = db
        .prepare(
          `SELECT COUNT(*) AS n FROM events_staging
           WHERE review_status = 'pending' AND (is_duplicate IS NULL OR is_duplicate = 0)
           AND IFNULL(json_extract(extraction_metadata_json, '$.auto_reject_reason'), '') != 'event_start_in_past'`
        )
        .get().n;
      const feedbackTotal = db.prepare(`SELECT COUNT(*) AS n FROM agent_feedback`).get().n;
      const feedback7d = db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_feedback WHERE created_at >= datetime('now', '-7 day')`
        )
        .get().n;
      const scopeDist = db
        .prepare(
          `SELECT hyperlocal_scope, COUNT(*) AS n FROM events_staging WHERE hyperlocal_scope IS NOT NULL
           GROUP BY hyperlocal_scope ORDER BY n DESC`
        )
        .all();

      return {
        generated_at: nowIso(),
        counts,
        staging: {
          by_review_status: byReview,
          by_qa_status: byQa,
          duplicates_flagged: dupStaging,
          past_events_auto_rejected: pastAutoRejected,
          pending_human_review: pendingHuman
        },
        hyperlocal_scope_distribution: scopeDist,
        agent_feedback: { total_rows: feedbackTotal, last_7_days: feedback7d }
      };
    },

    /**
     * Normalize stored URLs for dedupe alignment (run once after deploy or when legacy rows
     * predate canonical URL logic). Hub: if two rows collapse to the same canonical URL, the
     * later row (by id) is deleted. Staging: rows that would violate UNIQUE(source_id, url) are skipped.
     * @param {{ dryRun?: boolean, includeStaging?: boolean }} [options]
     */
    backfillCanonicalUrls(options = {}) {
      const dryRun = Boolean(options.dryRun);
      const includeStaging = options.includeStaging !== false;
      const now = nowIso();

      const hubRows = db.prepare(`SELECT * FROM community_hub_events ORDER BY id`).all();
      let hubUpdated = 0;
      let hubDeleted = 0;
      let hubUnchanged = 0;

      for (const row of hubRows) {
        const raw = (row.source_event_url || "").trim();
        if (!raw) {
          hubUnchanged += 1;
          continue;
        }
        const canon = normalizeCanonicalEventUrl(raw) || raw;
        if (canon === raw) {
          hubUnchanged += 1;
          continue;
        }

        const occupant = db.prepare(`SELECT id FROM community_hub_events WHERE source_event_url = ?`).get(canon);
        if (occupant && occupant.id !== row.id) {
          if (!dryRun) {
            db.prepare(`DELETE FROM community_hub_events WHERE id = ?`).run(row.id);
          }
          hubDeleted += 1;
          continue;
        }

        if (!dryRun) {
          const cHub = (row.community_hub_url || "").trim();
          const canonHub = normalizeCanonicalEventUrl(cHub) || cHub || canon;
          db.prepare(
            `UPDATE community_hub_events SET source_event_url = ?, community_hub_url = ?, updated_at = ? WHERE id = ?`
          ).run(canon, canonHub, now, row.id);
        }
        hubUpdated += 1;
      }

      const staging = { updated: 0, skipped_conflict: 0, unchanged: 0 };
      if (includeStaging) {
        const stRows = db.prepare(`SELECT * FROM events_staging ORDER BY id`).all();
        for (const row of stRows) {
          const raw = (row.source_event_url || "").trim();
          if (!raw) {
            staging.unchanged += 1;
            continue;
          }
          const canon = normalizeCanonicalEventUrl(raw) || raw;
          if (canon === raw) {
            staging.unchanged += 1;
            continue;
          }

          const occupant = db
            .prepare(`SELECT id FROM events_staging WHERE source_id = ? AND source_event_url = ?`)
            .get(row.source_id, canon);
          if (occupant && occupant.id !== row.id) {
            staging.skipped_conflict += 1;
            continue;
          }

          if (!dryRun) {
            db.prepare(`UPDATE events_staging SET source_event_url = ?, updated_at = ? WHERE id = ?`).run(
              canon,
              now,
              row.id
            );
          }
          staging.updated += 1;
        }
      }

      return {
        dry_run: dryRun,
        hub: {
          updated: hubUpdated,
          deleted: hubDeleted,
          unchanged: hubUnchanged
        },
        staging
      };
    },

    addAgentFeedback(input = {}) {
      const row = {
        id: makeId("fb"),
        staging_event_id: input.staging_event_id,
        source_id: input.source_id || null,
        fault_agent: input.fault_agent,
        rejection_reason: input.rejection_reason,
        reviewer_name: input.reviewer_name || null,
        created_at: nowIso()
      };
      statements.insertAgentFeedback.run(row);
      return feedbackRowToObject(row);
    },

    getAgentPromptGuidance(agentKey, limit = 8) {
      const rows = statements.listAgentFeedbackByAgent
        .all(agentKey, Math.max(1, Math.min(20, Number(limit) || 8)))
        .map(feedbackRowToObject);
      const uniqueReasons = [...new Set(rows.map((row) => String(row.rejection_reason || "").trim()).filter(Boolean))];
      return uniqueReasons.map((reason, idx) => `${idx + 1}. ${reason}`);
    }
  };
}
