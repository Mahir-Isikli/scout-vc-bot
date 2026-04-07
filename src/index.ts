/**
 * Scout Worker - Hono + Chat SDK + D1
 * Single Cloudflare Worker for both the Slack bot and the CRM API.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getBot, setContext } from "./bot";
import { getModel } from "./model";
import { makeExa } from "./enrich";
import {
  getDealsForApi, searchDealsForApi, getDealStats,
  listMeetings, searchMeetings as searchMtgs,
} from "./db";

type Env = {
  Bindings: {
    DB: D1Database;
    SLACK_BOT_TOKEN: string;
    SLACK_SIGNING_SECRET: string;
    GROQ_API_KEY: string;
    EXA_API_KEY: string;
  };
};

const app = new Hono<Env>();
app.use("*", cors());

// ── Health check ─────────────────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    name: "Scout Worker",
    version: "2.0.0",
    description: "VC deal flow Slack bot + CRM API on Cloudflare Workers with D1",
    bot: "Mention @Scout in Slack",
    api: {
      "GET /api/deals": "List deals (query: status, geo, stage, source, partner, search)",
      "GET /api/deals/search?q=": "Full-text search",
      "GET /api/deals/:id": "Single deal",
      "POST /api/deals": "Create deal",
      "GET /api/meetings": "List meetings (query: dealId)",
      "GET /api/meetings/search?q=": "Search meetings",
      "GET /api/stats": "Pipeline stats",
    },
  })
);

// ── Slack webhook ────────────────────────────────────────────────────

app.post("/api/webhooks/slack", async (c) => {
  // Set up env-dependent context for the bot handlers
  const env = c.env;
  process.env.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  process.env.SLACK_SIGNING_SECRET = env.SLACK_SIGNING_SECRET;
  process.env.GROQ_API_KEY = env.GROQ_API_KEY;
  process.env.EXA_API_KEY = env.EXA_API_KEY;

  const model = getModel(env.GROQ_API_KEY);
  const exa = makeExa(env.EXA_API_KEY);
  setContext(model, env.DB, exa);

  // Read body once
  const bodyText = await c.req.raw.text();

  // Handle Slack url_verification challenge, and dedupe duplicate event deliveries
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.type === "url_verification" && parsed.challenge) {
      return c.text(parsed.challenge, 200);
    }

    if (parsed.type === "event_callback" && parsed.event) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS slack_event_dedup (
          dedup_key TEXT PRIMARY KEY,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
      ).run();

      const ev = parsed.event as Record<string, any>;
      const normalizedText = typeof ev.text === "string"
        ? ev.text
            .replace(/<@[^>]+>/g, "")
            .replace(/@[A-Z0-9]{8,}/gi, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160)
        : "";
      const dedupKey = [
        ev.channel || "",
        ev.thread_ts || ev.ts || ev.event_ts || parsed.event_id || "",
        ev.user || "",
        normalizedText,
      ].join("|");

      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO slack_event_dedup (dedup_key) VALUES (?1)`
      ).bind(dedupKey).run();

      if ((inserted.meta?.changes ?? 0) === 0) {
        console.log(`[Scout] duplicate Slack event skipped: ${dedupKey}`);
        return c.text("ok", 200);
      }
    }
  } catch {
    // Not JSON, continue
  }

  // Reconstruct request for Chat SDK (it needs to read the body again for signature verification)
  const reconstructed = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: bodyText,
  });

  const bot = getBot();
  const handler = bot.webhooks.slack;
  if (!handler) {
    return c.text("Slack adapter not configured", 404);
  }

  return handler(reconstructed, {
    waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
  });
});

// ── CRM API: Deals ──────────────────────────────────────────────────

app.get("/api/deals/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing query parameter 'q'" }, 400);
  const results = await searchDealsForApi(c.env.DB, q);
  return c.json({ query: q, count: results.length, deals: results });
});

app.get("/api/deals/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM deals WHERE id = ?1").bind(id).first();
  if (!row) return c.json({ error: `Deal not found: ${id}` }, 404);
  const { results: mtgs } = await c.env.DB.prepare("SELECT * FROM meetings WHERE deal_id = ?1").bind(id).all();
  return c.json({ deal: row, meetings: mtgs || [] });
});

app.get("/api/deals", async (c) => {
  const results = await getDealsForApi(c.env.DB, {
    status: c.req.query("status"),
    geo: c.req.query("geo"),
    stage: c.req.query("stage"),
    source: c.req.query("source"),
    partner: c.req.query("partner"),
    search: c.req.query("search"),
  });
  return c.json({ count: results.length, deals: results });
});

app.post("/api/deals", async (c) => {
  const body = await c.req.json();
  const id = `deal-${Date.now()}`;
  const now = new Date().toISOString().split("T")[0];
  await c.env.DB.prepare(
    `INSERT INTO deals (id, company_name, founder_name, founder_linkedin, stage, round_size, round_size_eur, geo, status, rejection_reason, partner_assigned, source, date_received, notes, tags)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
  ).bind(
    id, body.companyName ?? null, body.founderName ?? "Unknown", body.founderLinkedin ?? null,
    body.stage ?? "pre-seed", body.roundSize ?? "Unknown", body.roundSizeEur ?? 0,
    body.geo ?? "Unknown", body.status ?? "new", body.rejectionReason ?? null,
    body.partnerAssigned ?? null, body.source ?? "email", now, body.notes ?? "",
    JSON.stringify(body.tags ?? []),
  ).run();
  const deal = await c.env.DB.prepare("SELECT * FROM deals WHERE id = ?1").bind(id).first();
  return c.json({ created: true, deal }, 201);
});

// ── CRM API: Meetings ───────────────────────────────────────────────

app.get("/api/meetings/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing query parameter 'q'" }, 400);
  const results = await searchMtgs(c.env.DB, q);
  return c.json({ query: q, count: results.length, meetings: results });
});

app.get("/api/meetings/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM meetings WHERE id = ?1").bind(id).first();
  if (!row) return c.json({ error: `Meeting not found: ${id}` }, 404);
  const deal = await c.env.DB.prepare("SELECT * FROM deals WHERE id = ?1").bind((row as any).deal_id).first();
  return c.json({ meeting: row, deal: deal ?? null });
});

app.get("/api/meetings", async (c) => {
  const dealId = c.req.query("dealId");
  const meetings = await listMeetings(c.env.DB, dealId || undefined);
  return c.json({ count: meetings.length, meetings });
});

// ── CRM API: Stats ──────────────────────────────────────────────────

app.get("/api/stats", async (c) => {
  const stats = await getDealStats(c.env.DB);
  const { results: mtgs } = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM meetings").all();
  return c.json({
    totalDeals: stats.total,
    thisWeekDeals: stats.thisWeek,
    totalMeetings: (mtgs?.[0] as any)?.cnt ?? 0,
    byStatus: stats.byStatus,
    byGeo: stats.byGeo,
    byStage: stats.byStage,
    pipeline: {
      active: (stats.byStatus["new"] || 0) + (stats.byStatus["reviewing"] || 0),
      passed: (stats.byStatus["passed"] || 0) + (stats.byStatus["rejected"] || 0),
      invested: stats.byStatus["invested"] || 0,
    },
  });
});

// ── 404 ─────────────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: "Not found", hint: "Try GET / for endpoints" }, 404));

export default app;
