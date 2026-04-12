import fs from "node:fs";

import Database from "better-sqlite3";

import { addMinutes, eventTitleKey, makeId, nowIso, parseJson } from "./utils.js";

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

    CREATE INDEX IF NOT EXISTS idx_sources_next_run_at ON sources(next_run_at);
    CREATE INDEX IF NOT EXISTS idx_event_candidates_source_id ON event_candidates(source_id);
    CREATE INDEX IF NOT EXISTS idx_events_staging_source_id ON events_staging(source_id);
    CREATE INDEX IF NOT EXISTS idx_source_runs_source_id ON source_runs(source_id);
  `);

  // Additive migrations — safe to run on existing databases
  for (const sql of [
    `ALTER TABLE events_staging ADD COLUMN hyperlocal_scope TEXT`,
    `ALTER TABLE events_staging ADD COLUMN geographic_tags_json TEXT NOT NULL DEFAULT '[]'`
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
        review_status, hyperlocal_scope, geographic_tags_json,
        community_hub_payload_json, raw_payload_json, discovered_at, updated_at
      ) VALUES (
        @id, @source_id, @source_candidate_id, @external_event_id, @title,
        @organizational_sponsor, @event_type_categories_json, @start_datetime, @end_datetime,
        @location_type, @location_or_address, @room_number, @event_link, @short_description,
        @extended_description, @artwork_url, @source_name, @source_domain, @source_listing_url,
        @source_event_url, @is_duplicate, @duplicate_match_url, @duplicate_reason, @confidence,
        @review_status, @hyperlocal_scope, @geographic_tags_json,
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
          hyperlocal_scope = @hyperlocal_scope,
          geographic_tags_json = @geographic_tags_json,
          community_hub_payload_json = @community_hub_payload_json,
          raw_payload_json = @raw_payload_json,
          updated_at = @updated_at
      WHERE id = @id
    `),
    insertHubEvent: db.prepare(`
      INSERT INTO community_hub_events (
        id, title, start_datetime, end_datetime, location_or_address, source_event_url,
        community_hub_url, raw_payload_json, created_at, updated_at
      ) VALUES (
        @id, @title, @start_datetime, @end_datetime, @location_or_address, @source_event_url,
        @community_hub_url, @raw_payload_json, @created_at, @updated_at
      )
    `),
    updateHubEventBySourceUrl: db.prepare(`
      UPDATE community_hub_events SET
        title = @title,
        start_datetime = @start_datetime,
        end_datetime = @end_datetime,
        location_or_address = @location_or_address,
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
    countTable: (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`),
    getStagingById: db.prepare(`SELECT * FROM events_staging WHERE id = ?`),
    patchStagingReviewStatus: db.prepare(`
      UPDATE events_staging SET review_status = @review_status, updated_at = @updated_at WHERE id = @id
    `),
    patchStagingFields: db.prepare(`
      UPDATE events_staging SET
        title = @title,
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
        updated_at = @updated_at
      WHERE id = @id
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
      const existing = statements.findStagingBySourceUrl.get(sourceId, event.source_event_url);
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
        source_event_url: event.source_event_url,
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

    addCommunityHubEvent(input) {
      const now = nowIso();
      const row = {
        id: input.id || makeId("hub"),
        title: input.title || null,
        start_datetime: input.start_datetime || null,
        end_datetime: input.end_datetime || null,
        location_or_address: input.location_or_address || null,
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
      const url = input.source_event_url?.trim();
      if (!url) {
        throw new Error("upsertCommunityHubEvent requires source_event_url");
      }
      const existing = statements.findHubBySourceUrl.get(url);
      const now = nowIso();
      const payload = {
        title: input.title || null,
        start_datetime: input.start_datetime || null,
        end_datetime: input.end_datetime || null,
        location_or_address: input.location_or_address || null,
        source_event_url: url,
        community_hub_url: input.community_hub_url || url,
        raw_payload_json: JSON.stringify(input.raw_payload || { snapshot: true }),
        updated_at: now
      };
      if (existing) {
        statements.updateHubEventBySourceUrl.run(payload);
        return { inserted: false, record: statements.findHubBySourceUrl.get(url) };
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
        source_event_url: row.source_event_url,
        community_hub_url: row.community_hub_url,
        raw_payload_json: row.raw_payload_json,
        created_at: row.created_at,
        updated_at: row.updated_at
      });
      return { inserted: true, record: row };
    },

    findDuplicateMatch(event, sourceId) {
      if (event.source_event_url) {
        const hubMatch = statements.findHubBySourceUrl.get(event.source_event_url);
        if (hubMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: hubMatch.community_hub_url || hubMatch.source_event_url,
            duplicate_reason: "exact_source_event_url_in_community_hub"
          };
        }

        const stagingUrlMatch = statements.findStagingBySourceUrlAny.get(event.source_event_url);
        if (stagingUrlMatch && stagingUrlMatch.source_id !== sourceId) {
          return {
            is_duplicate: true,
            duplicate_match_url: stagingUrlMatch.source_event_url,
            duplicate_reason: "exact_source_event_url_in_staging"
          };
        }
      }

      if (event.title && event.start_datetime) {
        const hubTitleMatch = statements.findHubByTitleAndStart.get(event.title, event.start_datetime);
        if (hubTitleMatch) {
          return {
            is_duplicate: true,
            duplicate_match_url: hubTitleMatch.community_hub_url || hubTitleMatch.source_event_url,
            duplicate_reason: "exact_title_and_start_in_community_hub"
          };
        }

        const stagingTitleMatch = statements.findStagingByTitleAndStart.get(
          event.title,
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

    getStagingById(id) {
      const row = statements.getStagingById.get(id);
      return row ? stagingRowToObject(row) : null;
    },

    updateStagingReviewStatus(id, status) {
      statements.patchStagingReviewStatus.run({
        id,
        review_status: status,
        updated_at: nowIso()
      });
      return this.getStagingById(id);
    },

    patchStagingFields(id, fields) {
      const current = this.getStagingById(id);
      if (!current) return null;
      statements.patchStagingFields.run({
        id,
        title: fields.title ?? current.title,
        organizational_sponsor: fields.organizational_sponsor ?? current.organizational_sponsor,
        start_datetime: fields.start_datetime ?? current.start_datetime,
        end_datetime: fields.end_datetime ?? current.end_datetime,
        location_type: fields.location_type ?? current.location_type,
        location_or_address: fields.location_or_address ?? current.location_or_address,
        room_number: fields.room_number ?? current.room_number,
        event_link: fields.event_link ?? current.event_link,
        short_description: fields.short_description ?? current.short_description,
        extended_description: fields.extended_description ?? current.extended_description,
        artwork_url: fields.artwork_url ?? current.artwork_url,
        updated_at: nowIso()
      });
      return this.getStagingById(id);
    },

    getSummaryCounts() {
      return {
        sources: statements.countTable("sources").get().count,
        event_candidates: statements.countTable("event_candidates").get().count,
        events_staging: statements.countTable("events_staging").get().count,
        community_hub_events: statements.countTable("community_hub_events").get().count,
        source_runs: statements.countTable("source_runs").get().count
      };
    }
  };
}
