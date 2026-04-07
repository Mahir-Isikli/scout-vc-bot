# Scout - AI Coding Agent Context

## What This Is

Scout is a Slack bot for VC deal flow operations. It runs as a single Cloudflare Worker with D1 database. The bot uses Vercel's Chat SDK for Slack integration and Kimi K2 (via Groq) as the AI brain.

## Project Structure

```
scout-worker/
  src/
    index.ts          # Hono app: webhook route + CRM API routes
    bot.ts            # Chat SDK bot: handlers, cards, intent detection
    model.ts          # AI model config (Kimi K2 via Groq)
    db.ts             # D1 database queries (deals, meetings, stats)
    enrich.ts         # Exa web search: instant, deep, live crawl
    parse-deal.ts     # LLM-powered unstructured text to deal parser
  migrations/
    0001_init.sql     # D1 schema: deals + meetings tables
  seed.sql            # 30 example deals + 13 meeting notes
  wrangler.toml       # Cloudflare Worker config + D1 binding
  .dev.vars           # Local dev secrets (not committed)
```

## Key Technical Decisions

### Chat SDK Cards: Function Call API, NOT JSX
The Chat SDK JSX runtime does NOT produce valid card elements. Cards created via JSX have `type: [Function]` instead of `type: "card"`, which means `isCardElement()` returns false and Slack gets empty blocks.

ALWAYS use the function call API:
```typescript
// CORRECT
Card({ title: "My Card", subtitle: "Sub", children: [
  CardText("Hello world"),
  Fields([
    Field({ label: "Name", value: "John" }),
    Field({ label: "Role", value: "Dev" }),
  ]),
  Divider(),
  Actions([
    Button({ id: "approve", style: "primary", label: "Approve" }),
    Button({ id: "reject", style: "danger", label: "Reject" }),
  ]),
]})

// WRONG (produces invalid card elements)
<Card title="My Card"><CardText>Hello</CardText></Card>
```

Button text goes in `label`, NOT `children`.

### Slack Mention Stripping
The Chat SDK converts `<@U0AR042K291>` to `@U0AR042K291` (no angle brackets). Strip with:
```typescript
text.replace(/@[A-Z0-9]+/g, "").replace(/\*?Sent using\*?\s+\w+/gi, "").trim()
```

### Slack URL Verification
The webhook route MUST handle Slack's `url_verification` challenge BEFORE passing to the Chat SDK handler:
```typescript
const bodyText = await request.text();
const parsed = JSON.parse(bodyText);
if (parsed.type === "url_verification") {
  return new Response(parsed.challenge, { status: 200 });
}
// Reconstruct request for Chat SDK (body stream was consumed)
const reconstructed = new Request(request.url, {
  method: request.method, headers: request.headers, body: bodyText
});
return bot.webhooks.slack(reconstructed, { waitUntil: ctx.waitUntil.bind(ctx) });
```

### Exa Enrichment Modes
- **Instant** (`type: "auto"`): ~200ms, use for quick lookups
- **Deep** (`type: "deep"`): ~5-10s, use for thorough research
- **Deep Reasoning** (`type: "deep-reasoning"`): ~15-30s, use for investment memos
- **Live Crawl** (`livecrawl: "always"`): Forces fresh data, use for funding news

### D1 Database
- Binding name: `DB`
- Two tables: `deals` (30+ fields), `meetings` (linked to deals)
- In-memory state adapter for Chat SDK (thread subscriptions)
- CRM data persists across redeployments

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | From Slack App Basic Information |
| `GROQ_API_KEY` | From console.groq.com |
| `EXA_API_KEY` | From exa.ai |

Set via `npx wrangler secret put VARIABLE_NAME` for production.
Set in `.dev.vars` for local development.

## Deployment

```bash
# Install deps
pnpm install

# Create D1 database (first time only)
npx wrangler d1 create scout-crm

# Run migrations
npx wrangler d1 execute scout-crm --remote --file=migrations/0001_init.sql

# Seed data (optional)
npx wrangler d1 execute scout-crm --remote --file=seed.sql

# Deploy
npx wrangler deploy
```

## Connecting a Real CRM

Replace D1 queries in `src/db.ts` with API calls to your CRM. The function signatures stay the same:
- `searchDeals(query)` - text search across deals
- `listDeals(status?)` - list/filter deals
- `createDeal(deal)` - write a new deal
- `getDealStats()` - pipeline statistics
- `searchMeetings(query)` - search meeting notes

Supported CRMs: Attio, Salesforce, HubSpot, Affinity. See README.md for API examples.

Start with read-only access. Add write permissions only after testing.

## Human-in-the-Loop

No automated action happens without user approval:
1. CRM writes require clicking "Add to CRM" button
2. Rejection emails are drafted, not sent
3. Enrichment results are shown for review
4. Deal parsing shows confidence scores (high/medium/low)
