# Scout - VC Deal Flow Assistant

An AI-powered Slack bot that helps venture capital teams manage deal flow. Parse inbound deals, query your pipeline, enrich companies with web research, draft rejection emails, and track your deal flow stats. All from Slack.

Built with [Vercel Chat SDK](https://github.com/vercel/chat), [Kimi K2](https://kimi.ai) via Groq, and deployed on [Cloudflare Workers](https://workers.cloudflare.com) with D1 for persistence.

**Built for the [Automate VC](https://lu.ma/automate-vc) event series.**

## What Scout Can Do

| Feature | Command | What Happens |
|---------|---------|-------------|
| **Parse deals** | Paste any unstructured text | Structures it into a rich Slack card with fields, buttons |
| **Query pipeline** | "Why did we pass on X?" | Pulls from CRM + meeting notes, answers in context |
| **Enrich data** | "Enrich [company]" | Web search for company, founder, competitors, funding news |
| **Deep research** | "Deep enrich [company]" | Thorough investment memo with market analysis |
| **Draft rejections** | "Draft rejection for [company]" | Warm, professional rejection email from CRM context |
| **Pipeline stats** | "Stats" | Executive dashboard: deals by status, geo, stage |

Every deal card comes with interactive buttons:
- **Add to CRM**: Writes the structured deal to your database (with confirmation)
- **Enrich**: Triggers web research on the company and founder
- **Reject**: Drafts a context-aware rejection email

## Architecture

![Scout Architecture](./architecture.png)

Slack events flow to a Cloudflare Worker running Hono + Chat SDK. The Worker uses Kimi K2 (via Groq) for AI, D1 for CRM data, and Exa for web enrichment. Every CRM write requires human confirmation via Slack buttons.

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR-USERNAME/scout-vc-bot
cd scout-vc-bot
pnpm install
```

### 2. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From scratch**
2. Name it **Scout**, pick your workspace
3. Go to **OAuth and Permissions**, add these Bot Token Scopes:
   - `app_mentions:read`, `chat:write`, `channels:read`, `channels:history`
   - `groups:read`, `groups:history`, `im:read`, `im:history`
   - `mpim:read`, `mpim:history`, `reactions:read`, `reactions:write`, `users:read`
4. Click **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-...`)
5. Go to **Basic Information**, copy the **Signing Secret**

### 3. Get API Keys

| Service | Where to Get It | What It Does |
|---------|----------------|-------------|
| **Groq** | [console.groq.com](https://console.groq.com) | Runs Kimi K2-0905 (free tier available) |
| **Exa** | [exa.ai](https://exa.ai) | Web search for company/founder enrichment |

### 4. Set Up Cloudflare

```bash
# Create the D1 database
npx wrangler d1 create scout-crm

# Update wrangler.toml with the database ID from the output above

# Run the migration to create tables
npx wrangler d1 execute scout-crm --local --file=migrations/0001_init.sql

# Seed with example data (optional, great for demos)
npx wrangler d1 execute scout-crm --local --file=seed.sql

# Set your secrets
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put EXA_API_KEY
```

### 5. Deploy

```bash
npx wrangler deploy
```

Copy the Worker URL (e.g., `https://scout-worker.your-subdomain.workers.dev`).

### 6. Connect Slack Events

1. Go to **Event Subscriptions** in your Slack App settings
2. Enable Events, paste: `https://YOUR-WORKER-URL/webhooks/slack`
3. Add bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`
4. Save Changes
5. Go to **Interactivity and Shortcuts**, enable, paste the same URL
6. Save Changes
7. **Reinstall the app** if prompted

### 7. Test

In any Slack channel where Scout is invited:
```
@Scout help
```

## Connecting Your Real CRM

Scout ships with a mock CRM (D1 database with example deals). To connect your real CRM, edit `src/db.ts` and replace the D1 queries with API calls to your CRM.

### Attio

```typescript
// Replace D1 queries with Attio API calls
const response = await fetch('https://api.attio.com/v2/objects/deals/records/query', {
  headers: { 'Authorization': `Bearer ${env.ATTIO_API_KEY}` },
  method: 'POST',
  body: JSON.stringify({ filter: { field: 'name', value: searchTerm } })
});
```

Get your API key at [developers.attio.com](https://developers.attio.com). Start with read-only access.

### Salesforce

```typescript
const response = await fetch(`${instanceUrl}/services/data/v59.0/query?q=SELECT+Name,StageName+FROM+Opportunity`, {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
```

You need a Connected App with OAuth. Scopes: `api`, `refresh_token`.

### HubSpot

```typescript
const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
  headers: { 'Authorization': `Bearer ${env.HUBSPOT_TOKEN}` },
  method: 'POST',
  body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: searchTerm }] }] })
});
```

Create a Private App at Settings > Integrations > Private Apps. Scopes: `crm.objects.deals.read`.

### Affinity

```typescript
const response = await fetch(`https://api.affinity.co/lists/${listId}/list-entries`, {
  headers: { 'Authorization': `Basic ${btoa(':' + env.AFFINITY_API_KEY)}` }
});
```

Get your API key at Settings > API.

## Human-in-the-Loop Guardrails

Scout is designed with confirmation flows so no automated action happens without your approval:

1. **CRM Writes**: When you paste a deal, Scout structures it and shows a card. You must click "Add to CRM" to actually write it. Nothing is auto-added.

2. **Rejection Emails**: Scout drafts the email and shows it to you in the thread. You review, edit if needed, and send manually. Scout never sends emails on its own.

3. **Enrichment**: Web search results are synthesized and shown to you. You decide what to do with the information.

4. **Data Accuracy**: Every parsed deal card shows a confidence score (high/medium/low). Low confidence means Scout couldn't extract much, so you should verify manually.

5. **Read-First Approach**: Start with read-only API access to your CRM. Add write access only after you trust the automation. Scout works great in read-only mode for queries and stats.

## Customizing the AI Model

Scout uses Kimi K2-0905 via Groq by default (fast, free tier). You can swap to any AI SDK-compatible model:

```typescript
// In src/model.ts

// Option 1: Claude (Anthropic)
import { anthropic } from '@ai-sdk/anthropic';
export const model = anthropic('claude-sonnet-4-6');

// Option 2: GPT-4 (OpenAI)
import { openai } from '@ai-sdk/openai';
export const model = openai('gpt-4o');

// Option 3: Llama via Groq
import { createGroq } from '@ai-sdk/groq';
const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
export const model = groq('llama-3.3-70b-versatile');
```

## Tech Stack

- [Cloudflare Workers](https://workers.cloudflare.com) with [Hono](https://hono.dev)
- [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge)
- [Vercel Chat SDK](https://github.com/vercel/chat) with Slack adapter
- [AI SDK](https://sdk.vercel.ai) with Groq provider
- [Kimi K2-0905](https://kimi.ai) via [Groq](https://groq.com) (fast inference)
- [Exa](https://exa.ai) for web search and deep research
- TypeScript, pnpm

## For AI Coding Agents

If you use Claude Code, Cursor, or another AI coding agent, install the Chat SDK skill:

```bash
npx skills add vercel/chat
```

Then tell your agent:
> "Read the AGENTS.md file for project context, and the Chat SDK skill for API patterns."

## License

MIT
