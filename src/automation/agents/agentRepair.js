/**
 * Repair agent (post–quality gate)
 * --------------------------------
 * When agentQualityGate reports fixable issues attributed to detail_extractor,
 * re-runs extractDashboardEventFromCandidate with synthetic candidate + targeted
 * “repair” lines in the prompt. Does not replace human review; avoids duplicate
 * full-pipeline code paths (invoked only from service.runQaRepairLoop).
 */
import { extractDashboardEventFromCandidate } from "../adapters/agentDetail.js";

const REPAIRABLE_CODES = new Set([
  "missing_title",
  "missing_organizational_sponsor",
  "missing_start_datetime",
  "missing_location_type",
  "broken_event_link",
  "broken_artwork_url",
  "invalid_artwork_content_type"
]);

export async function runRepairAgent(source, event, issues, runtimeConfig, feedbackGuidance = []) {
  const repairable = (issues || []).filter(
    (issue) => issue.fault_agent === "detail_extractor" && REPAIRABLE_CODES.has(issue.code)
  );
  if (!repairable.length) {
    return { attempted: false, repairedEvent: null };
  }

  const syntheticCandidate = {
    event_url: event.source_event_url,
    title_hint: event.title || null
  };
  const targetedGuidance = [
    ...feedbackGuidance,
    ...repairable.map((issue) => `Repair target: ${issue.message}`)
  ];
  const repairedEvent = await extractDashboardEventFromCandidate(
    source,
    syntheticCandidate,
    runtimeConfig,
    targetedGuidance
  );
  return { attempted: true, repairedEvent };
}

