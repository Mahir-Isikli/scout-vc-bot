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
git clone https://github.com/Mahir-Isikli/scout-vc-bot
cd scout-vc-bot
pnpm install
```

### 2. Sign up for services (all free)

| Service | Sign Up | What You Need | Free Tier |
|---------|---------|--------------|----------|
| **Cloudflare** | [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) | Account for Workers + D1 | 100K requests/day |
| **Slack App** | [api.slack.com/apps](https://api.slack.com/apps) | Bot Token + Signing Secret | Free |
| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) | API key for Kimi K2 | 30 req/min free |
| **Exa** | [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) | API key for web search | 1000 searches/month free |

### 3. Create a Slack App

1. Go to **[api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1)** (direct link to create)
2. Choose **"From scratch"**, name it **Scout**, pick your workspace
3. **Basic Information** page: copy the **Signing Secret**
4. Left sidebar > **OAuth and Permissions** > scroll to **Bot Token Scopes**, add:
   - `app_mentions:read`, `chat:write`, `channels:read`, `channels:history`
   - `groups:read`, `groups:history`, `im:read`, `im:history`
   - `mpim:read`, `mpim:history`, `reactions:read`, `reactions:write`, `users:read`
5. Scroll up, click **Install to Workspace**, authorize, copy the **Bot User OAuth Token** (`xoxb-...`)

### 4. Set up Cloudflare

Install the Wrangler CLI if you haven't:
```bash
pnpm add -g wrangler
wrangler login
```

Create the database and deploy:
```bash
# Create the D1 database
npx wrangler d1 create scout-crm
# Copy the database_id from the output and paste it in wrangler.toml

# Run the migration to create tables
npx wrangler d1 execute scout-crm --remote --file=migrations/0001_init.sql

# Seed with example data (optional, great for demos)
npx wrangler d1 execute scout-crm --remote --file=seed.sql

# Set your secrets (it will prompt for the value)
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put EXA_API_KEY
```

### 5. Deploy

```bash
npx wrangler deploy
```

Copy the Worker URL from the output (e.g., `https://scout-worker.YOUR-SUBDOMAIN.workers.dev`).

### 6. Connect Slack Events

1. Back in your Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. **Event Subscriptions** > toggle ON > paste: `https://YOUR-WORKER-URL/api/webhooks/slack`
3. Wait for green "Verified" checkmark
4. Under **Subscribe to bot events**, add: `app_mention`, `message.channels`, `message.groups`, `message.im`
5. Click **Save Changes**
6. **Interactivity and Shortcuts** > toggle ON > paste the same URL > Save
7. **Reinstall the app** if prompted (Install App > Reinstall to Workspace)

### 7. Test

Invite Scout to a channel (`/invite @Scout`) and type:
```
@Scout help
```

## Try It Without Deploying

Don't want to set up your own? Use our live demo API to explore the CRM data:

```
https://scout-worker.isiklimahir.workers.dev/api/deals
https://scout-worker.isiklimahir.workers.dev/api/deals/search?q=ai
https://scout-worker.isiklimahir.workers.dev/api/stats
https://scout-worker.isiklimahir.workers.dev/api/meetings
```

These endpoints are public. You can point your own Claude Code agent at them:
```
@Scout, use the CRM API at https://scout-worker.isiklimahir.workers.dev/api to query deals and meetings.
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
