import OpenAI from "openai";

import { normalizeDashboardSubmission, dashboardPayloadToStagingEvent } from "../community-hub.js";
import { parseModelJsonOutput } from "../utils.js";

/**
 * Poster / image extraction agent — research feature from the AI Micro Grant proposal.
 *
 * "We may also explore whether photographs of physical posters of events can
 *  be accurately decoded and reformatted."  (Section 9, grant application)
 *
 * Uses GPT-4o vision via the OpenAI Responses API to extract structured event
 * information directly from a poster image — URL or base64.
 *
 * @param {{ url?: string, base64?: string, mediaType?: string }} imageInput
 *   Provide either url (public HTTPS image URL) or base64 + mediaType.
 * @param {object} options
 *   - sourceName: label shown in source_name field (default "Poster Upload")
 * @returns {{ community_hub_payload: object, staging_event: object, model: string }}
 */
export async function runPosterExtractionAgent(imageInput, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("poster extraction agent requires OPENAI_API_KEY");
  }

  // GPT-4o is required for vision — fall back only if the override is also a vision model
  const model =
    process.env.OPENAI_POSTER_MODEL ||
    "gpt-4o";

  const sourceName = options.sourceName || "Poster Upload";

  // Build the image content block
  let imageBlock;
  if (imageInput.url) {
    imageBlock = { type: "input_image", image_url: imageInput.url };
  } else if (imageInput.base64) {
    const mt = imageInput.mediaType || "image/jpeg";
    imageBlock = {
      type: "input_image",
      image_url: `data:${mt};base64,${imageInput.base64}`
    };
  } else {
    throw new Error("posterAgent: provide either imageInput.url or imageInput.base64");
  }

  const client = new OpenAI({ apiKey });

  const instructions = `You are an event detail extractor for the Oberlin Community Hub calendar.

Look carefully at this poster or event announcement image.
Extract ALL event information that is visually present.

Return ONE JSON object only (no markdown, no fences) using these exact keys:

- title: string — the main event title (required)
- post_type: "Event" (or "Announcement" if clearly not an event)
- organizational_sponsor: string or null — host / department / sponsor visible on the poster
- event_type_categories: array of 1–3 short category strings inferred from the poster (e.g. ["Music","Concert"])
- start_datetime: ISO 8601 string — date + time shown on poster; assume America/New_York if no timezone
- end_datetime: ISO 8601 string or null — if shown
- location_type: one of "In-Person" | "Online" | "Both" | "Neither"
- location_or_address: string or null — venue name and/or address shown on poster
- room_number: string or null
- event_link: string or null — any URL or registration link visible on poster
- short_description_for_digital_signs: 1–2 sentence plain-text summary drawn from the poster (max 200 chars)
- extended_description_for_web_and_newsletter: full readable description from poster text, or null
- artwork_upload_or_gallery: null (the poster itself is the artwork; not stored here)
- display_target: "All Public Screens"
- contact_email: string or null — any email shown on the poster
- contact_phone: string or null — any phone shown on the poster
- organization_website: string or null — any website shown on the poster
- source_name: "${sourceName}"
- source_event_url: null

If a field cannot be read from the image, return null (or [] for arrays).
Do not invent dates, venues, or contact info that are not visible.`;

  const response = await client.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: instructions },
          imageBlock
        ]
      }
    ]
  });

  const text = response.output_text || "";
  let partial;
  try {
    partial = parseModelJsonOutput(text);
  } catch (e) {
    throw new Error(
      `posterAgent: bad JSON from model (${e.message}). Snippet: ${text.slice(0, 400)}`
    );
  }

  if (!partial.title) {
    throw new Error("posterAgent: model returned no title — image may not contain readable event info");
  }

  // Normalize into Community Hub payload shape
  const fakeSource = {
    source_name: sourceName,
    source_domain: "poster-upload",
    listing_url: null,
    attribution_label: sourceName
  };

  const hub = normalizeDashboardSubmission(partial, fakeSource);
  const stagingEvent = dashboardPayloadToStagingEvent(hub, fakeSource, {
    event_url: null,
    title_hint: partial.title
  });

  // Override raw_payload to record extraction method
  stagingEvent.raw_payload = {
    extraction: "poster_vision_v1",
    model,
    image_url: imageInput.url || "(base64)"
  };

  return {
    community_hub_payload: hub,
    staging_event: stagingEvent,
    model
  };
}
