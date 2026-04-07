/**
 * Scout Slack Bot - Chat SDK bot with all handlers and card builders.
 * Uses function call API for cards (NOT JSX).
 */
import {
  Chat, Card, CardText, Fields, Field, Actions, Button, Divider,
} from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type Exa from "exa-js";

import { SCOUT_SYSTEM_PROMPT } from "./model";
import { parseDealFromText, type ParsedDeal } from "./parse-deal";
import {
  searchDeals, listDeals, createDeal, getDealStats, searchMeetings,
  type Deal, type DealStats,
} from "./db";
import {
  enrichDeal, deepEnrichDeal, searchCompany, searchFounder,
} from "./enrich";

// ---------------------------------------------------------------------------
// Singleton bot
// ---------------------------------------------------------------------------

let _bot: Chat | null = null;

export function getBot(): Chat {
  if (!_bot) {
    _bot = new Chat({
      userName: "scout",
      adapters: { slack: createSlackAdapter() },
      state: createMemoryState(),
      dedupeTtlMs: 600_000,
    });
    wireHandlers(_bot);
  }
  return _bot;
}

// We need to pass env-dependent things (model, db, exa) via a context holder
// because the Chat SDK handlers are registered once at startup.
let _ctx: { model: LanguageModel; db: D1Database; exa: Exa } | null = null;

export function setContext(model: LanguageModel, db: D1Database, exa: Exa) {
  _ctx = { model, db, exa };
}

function ctx() {
  if (!_ctx) throw new Error("Bot context not set. Call setContext() first.");
  return _ctx;
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

type Intent =
  | { type: "parse_deal"; text: string }
  | { type: "query"; question: string }
  | { type: "rejection_email"; company: string }
  | { type: "enrich"; target: string }
  | { type: "deep_enrich"; target: string }
  | { type: "stats" }
  | { type: "help" }
  | { type: "general"; text: string };

function detectIntent(text: string): Intent {
  const lower = text.toLowerCase().trim();
  if (lower.startsWith("help") || lower === "commands") return { type: "help" };
  if (lower.startsWith("stats") || lower.startsWith("pipeline") || lower.startsWith("dashboard")) return { type: "stats" };
  if (lower.startsWith("draft rejection") || lower.startsWith("reject ") || /rejection\s+(email|for)\s+/i.test(lower)) {
    return { type: "rejection_email", company: text.replace(/^.*?(?:rejection|reject)\s+(?:email\s+)?(?:for\s+)?/i, "").trim() };
  }
  if (lower.startsWith("deep enrich ") || lower.startsWith("deep research ")) {
    return { type: "deep_enrich", target: text.replace(/^deep\s+(?:enrich|research)\s+/i, "").trim() };
  }
  if (lower.startsWith("enrich ") || lower.startsWith("research ") || lower.startsWith("look up ")) {
    return { type: "enrich", target: text.replace(/^(?:enrich|research|look\s+up)\s+/i, "").trim() };
  }
  // Deal parsing: check BEFORE query so long deal descriptions aren't misclassified
  const dealIndicators = ["raising","round","seed","series","pre-seed","founder","ceo","startup","linkedin.com","pitch","deck","inbound","intro","referred","check out","take a look","forwarding","fyi","new deal","deal:","company:","million","saas","b2b","fintech","healthtech","deeptech","ai ","ml "];
  const hasDealSignals = dealIndicators.filter((ind) => lower.includes(ind)).length;
  if (hasDealSignals >= 2 || (lower.length > 60 && hasDealSignals >= 1)) {
    return { type: "parse_deal", text };
  }
  // CRM queries
  if (/^(why did we|how many|what|who|when did|show me|find |check |list |get |search |query )/i.test(lower) || lower.includes("?") || /\b(crm|deals?|pipeline|portfolio|reviewing|rejected|passed|invested|all deals|our deals|the deals)\b/i.test(lower)) {
    return { type: "query", question: text };
  }
  if (lower.length > 40) {
    return { type: "parse_deal", text };
  }
  return { type: "general", text };
}

// ---------------------------------------------------------------------------
// Card builders (function call API)
// ---------------------------------------------------------------------------

function mergeParsedDeals(base: ParsedDeal, refined: ParsedDeal): ParsedDeal {
  const prefer = (primary?: string, fallback?: string) => {
    const cleaned = (primary || "").trim();
    if (!cleaned || cleaned.toLowerCase() === "unknown") return fallback || "Unknown";
    return cleaned;
  };

  const confidenceRank: Record<ParsedDeal["confidence"], number> = { low: 0, medium: 1, high: 2 };
  const mergedNotes = [base.notes, refined.notes]
    .filter(Boolean)
    .map((n) => n!.trim())
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .join(" | ");

  return {
    company: prefer(refined.company, base.company),
    founder: prefer(refined.founder, base.founder),
    founderLinkedIn: prefer(refined.founderLinkedIn, base.founderLinkedIn) || undefined,
    stage: prefer(refined.stage, base.stage),
    roundSize: prefer(refined.roundSize, base.roundSize),
    geo: prefer(refined.geo, base.geo),
    sector: prefer(refined.sector, base.sector),
    source: prefer(refined.source, base.source),
    notes: mergedNotes || undefined,
    confidence: confidenceRank[refined.confidence] >= confidenceRank[base.confidence] ? refined.confidence : base.confidence,
  };
}

function buildDealCard(deal: ParsedDeal, showActions = true) {
  const stageEmoji: Record<string, string> = { "Pre-seed": "🌱", Seed: "🌿", "Series A": "🚀", "Series B": "📈", "Series C+": "🏢", Unknown: "❓" };
  const confEmoji: Record<string, string> = { high: "🟢", medium: "🟡", low: "🔴" };
  const children: any[] = [
    Fields([
      Field({ label: "👤 Founder(s)", value: deal.founder }),
      Field({ label: "🏭 Sector", value: deal.sector }),
      Field({ label: "📥 Source", value: deal.source }),
      Field({ label: "🎯 AI Confidence", value: `${confEmoji[deal.confidence] || "❓"} ${deal.confidence}` }),
    ]),
  ];
  const details: string[] = [];
  if (deal.founderLinkedIn) details.push(`🔗 *LinkedIn:* ${deal.founderLinkedIn}`);
  if (deal.notes) details.push(`📝 *Notes:* ${deal.notes}`);
  if (details.length > 0) { children.push(Divider()); children.push(CardText(details.join("\n"))); }
  if (showActions) {
    children.push(Divider());
    children.push(Actions([
      Button({ id: "add_to_crm", style: "primary", label: "✅ Add to CRM", value: JSON.stringify(deal) }),
      Button({ id: "deep_enrich_deal", label: "🔍 Deep Enrich", value: JSON.stringify({ company: deal.company, founder: deal.founder, sector: deal.sector, deal }) }),
      Button({ id: "reject_deal", style: "danger" as any, label: "✉️ Pass / Reject", value: deal.company }),
    ]));
  }
  return Card({ title: `🏢 ${deal.company}`, subtitle: `${stageEmoji[deal.stage] || "❓"} ${deal.stage}  •  💰 ${deal.roundSize}  •  📍 ${deal.geo}`, children });
}

function buildStatsCard(stats: DealStats) {
  const fmt = (obj: Record<string, number>) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `• ${k}: ${v}`).join("\n") || "None";
  return Card({ title: "📊 Pipeline Dashboard", subtitle: "Real-time overview of your deal flow", children: [
    Fields([Field({ label: "📈 Total Deals", value: String(stats.total) }), Field({ label: "🔥 This Week", value: String(stats.thisWeek) })]),
    Divider(),
    Fields([
      Field({ label: "📋 Pipeline Status", value: fmt(stats.byStatus) }),
      Field({ label: "🌍 Top Geographies", value: fmt(stats.byGeo) }),
      Field({ label: "🌱 Stage Breakdown", value: fmt(stats.byStage) }),
    ]),
    Divider(),
    Actions([Button({ id: "refresh_stats", label: "🔄 Refresh Data" })]),
  ]});
}

function buildHelpCard() {
  return Card({ title: "🤖 Scout AI Assistant", subtitle: "Your automated VC deal flow operations partner", children: [
    CardText("I'm here to help you manage the pipeline, run research, and draft emails. Just mention me `@Scout` with any of these commands:"),
    Divider(),
    Fields([
      Field({ label: "📥 Parse Deal", value: "Paste any unstructured text, WhatsApp forward, or email snippet." }),
      Field({ label: "❓ Query CRM", value: '"Why did we pass on DataForge?" or "How many Seed deals?"' }),
      Field({ label: "🔍 Quick Enrich", value: '"Enrich [Company]" for instant web data on founders & market.' }),
      Field({ label: "🔬 Deep Research", value: '"Deep enrich [Company]" for a full investment memo.' }),
      Field({ label: "✉️ Draft Rejection", value: '"Draft rejection for [Company]" for a warm, context-aware email.' }),
      Field({ label: "📊 View Pipeline", value: '"Stats" or "Dashboard" for a real-time portfolio overview.' }),
    ]),
  ]});
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleMessage(thread: any, rawText: string) {
  const text = rawText.replace(/@[A-Z0-9]+/g, "").replace(/\*?Sent using\*?\s+\w+/gi, "").trim();
  console.log(`[Scout] raw="${rawText}" cleaned="${text}"`);
  const intent = detectIntent(text);
  console.log(`[Scout] intent=${intent.type}`);

  try {
    switch (intent.type) {
      case "help": await thread.post(buildHelpCard()); break;
      case "stats": await handleStats(thread); break;
      case "parse_deal": await handleParseDeal(thread, intent.text); break;
      case "query": await handleQuery(thread, intent.question); break;
      case "rejection_email": await handleRejection(thread, intent.company); break;
      case "enrich": await handleEnrich(thread, intent.target); break;
      case "deep_enrich": await handleDeepEnrich(thread, intent.target); break;
      case "general": await handleGeneral(thread, intent.text); break;
    }
  } catch (err) {
    console.error("Handler error:", err);
    await thread.post(`Something went wrong. Error: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

async function handleParseDeal(thread: any, rawText: string) {
  await thread.post("🔍 Parsing deal info...");
  const parsed = await parseDealFromText(ctx().model, rawText);
  await thread.post(buildDealCard(parsed));
}

async function handleQuery(thread: any, question: string) {
  const { model, db } = ctx();
  let crmContext = "";
  const lower = question.toLowerCase();

  const appendDealsContext = (deals: Awaited<ReturnType<typeof listDeals>>, label: string) => {
    if (deals.length === 0) return;
    crmContext += `\n\n${label}:\n`;
    for (const d of deals.slice(0, 20)) {
      crmContext += `- ${d.company} (${d.status}): ${d.stage}, ${d.roundSize}, ${d.geo}, Sector: ${d.sector}`;
      if (d.rejectionReason) crmContext += `, Rejection: ${d.rejectionReason}`;
      if (d.partner) crmContext += `, Partner: ${d.partner}`;
      if (d.notes) crmContext += `, Notes: ${d.notes}`;
      crmContext += "\n";
    }
    if (deals.length > 20) crmContext += `... and ${deals.length - 20} more\n`;
  };

  try {
    const statusMatch = lower.match(/\b(new|reviewing|passed|rejected|invested)\b/);
    const asksForList = /\b(all|list|show|every|export|overview|summary|total)\b/i.test(lower) || lower.startsWith("show me");
    const asksAboutCollection = /\b(deals?|crm|pipeline|portfolio|records?)\b/i.test(lower);
    const asksWhatWeHave = /what.*\b(have|in the crm|in crm|pipeline|records)\b/i.test(lower);
    const isBroad = !!statusMatch || (asksForList && asksAboutCollection) || asksWhatWeHave || /\bhow many\b/i.test(lower);

    if (isBroad) {
      const deals = await listDeals(db, statusMatch?.[1]);
      appendDealsContext(deals, `CRM contains ${deals.length} deals${statusMatch ? ` with status '${statusMatch[1]}'` : " total"}`);
    } else {
      const searchTerm = (question.match(/(?:on|about|for|at)\s+([A-Z][A-Za-z0-9\s]+?)(?:\?|$|\s+(?:and|or|but))/)?.[1] ||
        question.replace(/^(?:why did we |how many |what |who |when did |show me |find |check |list |get |search |query )/i, "").replace(/\?$/, "")).trim();
      const normalizedSearch = searchTerm.toLowerCase();
      if (["deal", "deals", "crm", "pipeline", "portfolio", "records"].includes(normalizedSearch)) {
        const deals = await listDeals(db);
        appendDealsContext(deals, `CRM contains ${deals.length} deals total`);
      } else if (searchTerm.length > 1) {
        const deals = await searchDeals(db, searchTerm);
        if (deals.length > 0) {
          crmContext += "\n\nRelevant deals from CRM:\n";
          for (const d of deals) {
            crmContext += `- ${d.company} (${d.status}): ${d.stage}, ${d.roundSize}, ${d.geo}`;
            if (d.rejectionReason) crmContext += `, Rejection: ${d.rejectionReason}`;
            if (d.notes) crmContext += `, Notes: ${d.notes}`;
            crmContext += "\n";
          }
        }
      }
    }

    const searchTerm = question.replace(/^(?:why did we |how many |what |who |when did |show me |find |check |list |get |search |query )/i, "").replace(/\?$/, "").trim();
    if (searchTerm.length > 2 && !["deal", "deals", "crm", "pipeline", "portfolio", "records"].includes(searchTerm.toLowerCase())) {
      const meetings = await searchMeetings(db, searchTerm);
      if (meetings.length > 0) {
        crmContext += "\nRelevant meeting notes:\n";
        for (const m of meetings) {
          crmContext += `- ${m.date} \"${m.title}\": ${m.summary}`;
          if (m.outcome) crmContext += ` Outcome: ${m.outcome}`;
          crmContext += "\n";
        }
      }
    }
  } catch (err: any) {
    console.error("CRM query failed:", err?.message);
    crmContext = "\n\n(Could not reach CRM)";
  }

  const result = streamText({
    model,
    system: `${SCOUT_SYSTEM_PROMPT}\n\nYou have access to the following CRM and meeting data to answer the question:${crmContext || "\n\n(No matching records found in CRM)"}\n\nImportant: if CRM data is present above, never say the CRM is empty or unreachable. Answer only from the provided CRM context.`,
    prompt: question,
  });
  await thread.post(result.textStream);
}

async function handleRejection(thread: any, company: string) {
  const { model, db } = ctx();
  await thread.post(`✉️ Drafting rejection for ${company}...`);
  let dealContext = "";
  try {
    const deals = await searchDeals(db, company);
    if (deals.length > 0) {
      const d = deals[0];
      dealContext = `\nDeal context:\n- Company: ${d.company}\n- Founder: ${d.founder}\n- Stage: ${d.stage}\n- Round: ${d.roundSize}\n- Sector: ${d.sector}\n- Rejection Reason: ${d.rejectionReason || "Not specified"}\n- Partner: ${d.partner || "Unknown"}`;
    }
  } catch { dealContext = ""; }

  const result = streamText({
    model,
    system: `${SCOUT_SYSTEM_PROMPT}\n\nDraft a rejection email. Be warm, professional, concise. Thank them, give a brief honest reason, leave the door open. Under 150 words. Sign as the partner if known.${dealContext}`,
    prompt: `Draft a rejection email for ${company}.`,
  });
  await thread.post(result.textStream);
}

async function handleEnrich(thread: any, target: string) {
  const { model, exa } = ctx();
  await thread.post(`🔍 Researching ${target}...`);
  const [cr, fr] = await Promise.all([searchCompany(exa, target), searchFounder(exa, target)]);
  const all = [...cr, ...fr];
  if (all.length === 0) { await thread.post(`Could not find much about "${target}".`); return; }
  const src = all.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.text}`).join("\n\n---\n\n");
  const result = streamText({ model, system: `${SCOUT_SYSTEM_PROMPT}\n\nSynthesize into a concise brief:\n**Company Overview**\n**Founder Background**\n**Funding History**\n**Competitors / Market**\n**Key Links**\n\nCite [1], [2] etc.\n\nResults:\n${src}`, prompt: `Enrichment brief for: ${target}` });
  await thread.post(result.textStream);
}

async function runDeepEnrich(thread: any, company: string, founder?: string, sector?: string, originalDeal?: ParsedDeal) {
  const { model, exa } = ctx();
  const normalizedFounder = founder && founder !== "Unknown" ? founder : undefined;
  const normalizedSector = sector && sector !== "Unknown" ? sector : undefined;

  await thread.post(`🔬 Running deep research on ${company}... (10-20 seconds)`);

  try {
    let { companyResults, founderResults, competitorResults, marketResults } = await deepEnrichDeal(
      exa,
      company,
      normalizedFounder,
      normalizedSector,
    );

    let all = [...companyResults, ...founderResults, ...competitorResults, ...marketResults];

    // Fallback to the faster enrichment path if deep mode returns nothing useful.
    if (all.length === 0) {
      const fallback = await enrichDeal(exa, company, normalizedFounder, normalizedSector);
      all = [...fallback.companyResults, ...fallback.founderResults, ...fallback.competitorResults, ...fallback.fundingNews];
    }

    if (all.length === 0) {
      await thread.post(`No deep research results for "${company}".`);
      return;
    }

    const src = all.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.text}`).join("\n\n---\n\n");
    const refinedDealPromise = originalDeal
      ? parseDealFromText(
          model,
          `Original structured deal:\n${JSON.stringify(originalDeal, null, 2)}\n\nResearch notes for ${company}:\n${src.slice(0, 12000)}`,
        )
      : Promise.resolve(null);

    const result = streamText({
      model,
      system: `${SCOUT_SYSTEM_PROMPT}\n\nProduce a DEEP RESEARCH REPORT:\n## Company Overview\n## Founder & Team\n## Product & Traction\n## Funding History\n## Competitive Landscape\n## Market Opportunity\n## Key Risks\n## Sources\n\nCite [1],[2] etc.\n\nResults:\n${src}`,
      prompt: `Deep research report for: ${company}`,
    });
    await thread.post(result.textStream);

    const refinedDeal = await refinedDealPromise;
    if (originalDeal && refinedDeal) {
      const mergedDeal = mergeParsedDeals(originalDeal, refinedDeal);
      mergedDeal.notes = [mergedDeal.notes, "Deep research completed. Ready to save to CRM."].filter(Boolean).join(" | ");
      await thread.post(buildDealCard(mergedDeal));
    }
  } catch (err) {
    console.error("Deep enrich failed:", err);
    await thread.post(`Deep research failed for ${company}. Try again in a few seconds.`);
  }
}

async function handleDeepEnrich(thread: any, target: string) {
  await runDeepEnrich(thread, target);
}

async function handleStats(thread: any) {
  try {
    const stats = await getDealStats(ctx().db);
    await thread.post(buildStatsCard(stats));
  } catch (err) {
    console.error("Stats failed:", err);
    await thread.post("Could not fetch pipeline stats.");
  }
}

async function handleGeneral(thread: any, text: string) {
  const result = streamText({ model: ctx().model, system: SCOUT_SYSTEM_PROMPT, prompt: text });
  await thread.post(result.textStream);
}

// ---------------------------------------------------------------------------
// Wire handlers (called once at startup)
// ---------------------------------------------------------------------------

function wireHandlers(bot: Chat) {
  bot.onNewMention(async (thread, message) => {
    console.log(`[Scout] onNewMention text="${message.text}"`);
    try { await thread.subscribe(); } catch (e) { console.error("[Scout] subscribe failed:", e); }
    const text = message.text?.trim();
    if (!text) { await thread.post("Hey! Paste a deal, ask a question, or type `help`."); return; }
    try { await handleMessage(thread, text); } catch (e) { console.error("[Scout] handleMessage error:", e); }
  });

  bot.onSubscribedMessage(async (thread, message) => {
    const text = message.text?.trim();
    if (!text) return;
    // Skip messages that contain a bot mention (already handled by onNewMention)
    // Chat SDK strips angle brackets, so text looks like "@U0AR042K291 help"
    if (/@?U[A-Z0-9]{8,}/i.test(text)) {
      console.log(`[Scout] skipping subscribed msg (has mention, handled by onNewMention)`);
      return;
    }
    await handleMessage(thread, text);
  });

  bot.onAction("add_to_crm", async (event) => {
    try {
      const dealData: ParsedDeal = JSON.parse(event.value || "{}");
      const created = await createDeal(ctx().db, {
        company: dealData.company, founder: dealData.founder, founderLinkedIn: dealData.founderLinkedIn,
        stage: dealData.stage, roundSize: dealData.roundSize, geo: dealData.geo,
        sector: dealData.sector, source: dealData.source, status: "new", notes: dealData.notes,
      });
      await event.thread!.post(Card({ title: "✅ Added to CRM", children: [CardText(`${dealData.company} added (ID: ${created.id}).`)] }));
    } catch (err) {
      await event.thread!.post(`Failed to add: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  });

  const handleDeepEnrichAction = async (event: any) => {
    let company = "the company";
    let founder: string | undefined;
    let sector: string | undefined;
    let originalDeal: ParsedDeal | undefined;

    try {
      if ((event.value || "").startsWith("{")) {
        const parsed = JSON.parse(event.value || "{}");
        company = parsed.company || company;
        founder = parsed.founder;
        sector = parsed.sector;
        originalDeal = parsed.deal;
      } else {
        const parts = (event.value || "").split("|");
        company = parts[0] || company;
        founder = parts[1];
        sector = parts[2];
      }
    } catch {
      company = event.value || company;
    }

    await runDeepEnrich(event.thread!, company, founder, sector, originalDeal);
  };

  bot.onAction("deep_enrich_deal", handleDeepEnrichAction);
  // Backward compatibility for older cards that already exist in Slack
  bot.onAction("enrich_deal", handleDeepEnrichAction);

  bot.onAction("reject_deal", async (event) => {
    await handleRejection(event.thread!, event.value || "the company");
  });

  bot.onAction("refresh_stats", async (event) => {
    await handleStats(event.thread!);
  });
}
