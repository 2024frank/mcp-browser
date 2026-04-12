# Agent Builder Phase 1

## First Agent

Start with the `Listing Collector Agent`.

Its only job is to collect event links from one listing page.

## Smallest Working Canvas

```text
Start -> Listing Collector Agent -> End
```

Do not add loops, branching, or duplicate checking yet.

## Agent Settings

- Model: `gpt-4.1-2025-04-14`
- Tool: browser MCP
- Tool choice: `required`
- Output format: `JSON`
- Include chat history: `Off`
- Temperature: `0.2`

## Output Schema

Use this JSON shape in the Agent Builder output schema:

```json
{
  "source": "string",
  "listing_url": "string",
  "event_links": [
    {
      "title_hint": "string",
      "event_url": "string"
    }
  ],
  "next_page_url": "string"
}
```

If there is no next page, use an empty string for `next_page_url`.

## Instructions

Paste this into the agent instructions:

```text
You are a listing collector agent.

Your only job is to collect event page links from one public event listing page.

You MUST use browser tools for all web access.

The user will provide:
- source
- listing_url
- max_links

Workflow:
1. Use browser_navigate to open the exact listing_url from the user.
2. Use browser_wait_for after navigation.
3. Use browser_snapshot before extracting.
4. Identify visible links in the main event listing content that appear to be individual event pages.
5. Ignore header links, navigation, footer links, filters, category links, search links, social links, and the listing page URL itself.
6. Return up to max_links event links from the current page only.
7. If a visible next-page link exists, return its direct URL as next_page_url.
8. If there is no visible next page, return next_page_url as an empty string.

Output rules:
- Return JSON only.
- source must exactly match the source provided by the user.
- listing_url must exactly match the URL provided by the user.
- event_url must be a direct clickable absolute URL.
- title_hint should be the visible link text when available.
- Do not open event detail pages yet.
- Do not invent links.
- Never return {}.
```

## First Test Prompt

```text
source: experienceoberlin.com
listing_url: https://experienceoberlin.com/events
max_links: 5

Collect event links from the current page only.
```

## Expected Result Pattern

```json
{
  "source": "experienceoberlin.com",
  "listing_url": "https://experienceoberlin.com/events",
  "event_links": [
    {
      "title_hint": "Oberlin Farmers Market",
      "event_url": "https://www.experienceoberlin.com/event/oberlin-farmers-market/"
    }
  ],
  "next_page_url": ""
}
```

## Next Step After It Works

The second agent should be the `Event Detail Extractor Agent`, which takes:

- `source`
- `source_event_url`

and returns one normalized event record.
