/** D1 database queries for deals and meetings */

// Types matching the bot's internal representation
export interface Deal {
  id: string;
  company: string;
  founder: string;
  founderLinkedIn?: string;
  stage: string;
  roundSize: string;
  geo: string;
  sector: string;
  source: string;
  status: string;
  rejectionReason?: string;
  partner?: string;
  notes?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Meeting {
  id: string;
  title: string;
  date: string;
  participants: string[];
  dealId?: string;
  summary: string;
  actionItems: string[];
  outcome?: string;
}

export interface DealStats {
  total: number;
  byStatus: Record<string, number>;
  byGeo: Record<string, number>;
  bySector: Record<string, number>;
  byStage: Record<string, number>;
  thisWeek: number;
  thisMonth: number;
}

// ── Row mappers ──────────────────────────────────────────────────────

function mapDealRow(r: any): Deal {
  const tags: string[] = r.tags ? JSON.parse(r.tags) : [];
  const sectorTags = tags.filter(
    (t: string) =>
      !["stealth","hot-deal","second-time-founder","solo-founder","too-large","wish-we-had","conflict","overpriced","competitive","unverified","remote","berlin","france","germany","uk","portugal","poland","dach"].includes(t)
  );
  return {
    id: r.id,
    company: r.company_name || "Stealth",
    founder: r.founder_name,
    founderLinkedIn: r.founder_linkedin || undefined,
    stage: r.stage,
    roundSize: r.round_size,
    geo: r.geo,
    sector: sectorTags.slice(0, 2).join(", ") || "Unknown",
    source: r.source,
    status: r.status,
    rejectionReason: r.rejection_reason || undefined,
    partner: r.partner_assigned || undefined,
    notes: r.notes || undefined,
    tags,
    createdAt: r.date_received,
    updatedAt: r.updated_at || r.date_received,
  };
}

function mapMeetingRow(r: any): Meeting {
  const decisions: string[] = r.key_decisions ? JSON.parse(r.key_decisions) : [];
  return {
    id: r.id,
    title: r.title,
    date: r.date,
    participants: r.participants ? JSON.parse(r.participants) : [],
    dealId: r.deal_id,
    summary: r.summary,
    actionItems: r.action_items ? JSON.parse(r.action_items) : [],
    outcome: decisions.length > 0 ? decisions[0] : undefined,
  };
}

// ── Deal queries ─────────────────────────────────────────────────────

export async function searchDeals(db: D1Database, query: string): Promise<Deal[]> {
  const q = `%${query.toLowerCase()}%`;
  const { results } = await db.prepare(
    `SELECT * FROM deals WHERE
      LOWER(COALESCE(company_name,'')) LIKE ?1
      OR LOWER(founder_name) LIKE ?1
      OR LOWER(notes) LIKE ?1
      OR LOWER(tags) LIKE ?1
      OR LOWER(COALESCE(rejection_reason,'')) LIKE ?1
      OR LOWER(COALESCE(partner_assigned,'')) LIKE ?1
    ORDER BY date_received DESC`
  ).bind(q).all();
  return (results || []).map(mapDealRow);
}

export async function listDeals(db: D1Database, status?: string): Promise<Deal[]> {
  if (status) {
    const { results } = await db.prepare(
      "SELECT * FROM deals WHERE status = ?1 ORDER BY date_received DESC"
    ).bind(status).all();
    return (results || []).map(mapDealRow);
  }
  const { results } = await db.prepare(
    "SELECT * FROM deals ORDER BY date_received DESC"
  ).all();
  return (results || []).map(mapDealRow);
}

export async function getDeal(db: D1Database, id: string): Promise<Deal | null> {
  const row = await db.prepare("SELECT * FROM deals WHERE id = ?1").bind(id).first();
  return row ? mapDealRow(row) : null;
}

export async function createDeal(db: D1Database, deal: Omit<Deal, "id" | "createdAt" | "updatedAt">): Promise<Deal> {
  const id = `deal-${Date.now()}`;
  const now = new Date().toISOString().split("T")[0];
  const tags = JSON.stringify(deal.tags || [deal.sector?.toLowerCase()].filter(Boolean));

  await db.prepare(
    `INSERT INTO deals (id, company_name, founder_name, founder_linkedin, stage, round_size, round_size_eur, geo, status, rejection_reason, partner_assigned, source, date_received, notes, tags)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
  ).bind(
    id,
    deal.company === "Stealth" ? null : deal.company,
    deal.founder,
    deal.founderLinkedIn || null,
    deal.stage.toLowerCase().replace(" ", "-"),
    deal.roundSize,
    0,
    deal.geo,
    deal.status || "new",
    deal.rejectionReason || null,
    deal.partner || null,
    deal.source || "email",
    now,
    deal.notes || "",
    tags,
  ).run();

  return { ...deal, id, createdAt: now, updatedAt: now };
}

export async function getDealStats(db: D1Database): Promise<DealStats> {
  const { results: all } = await db.prepare("SELECT * FROM deals").all();
  const deals = (all || []).map(mapDealRow);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const byStatus: Record<string, number> = {};
  const byGeo: Record<string, number> = {};
  const bySector: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  let thisWeek = 0;
  let thisMonth = 0;

  for (const d of deals) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    byGeo[d.geo] = (byGeo[d.geo] || 0) + 1;
    byStage[d.stage] = (byStage[d.stage] || 0) + 1;
    if (d.sector) bySector[d.sector] = (bySector[d.sector] || 0) + 1;
    const received = new Date(d.createdAt);
    if (received >= weekAgo) thisWeek++;
    if (received >= monthAgo) thisMonth++;
  }

  return { total: deals.length, byStatus, byGeo, bySector, byStage, thisWeek, thisMonth };
}

// ── Meeting queries ──────────────────────────────────────────────────

export async function searchMeetings(db: D1Database, query: string): Promise<Meeting[]> {
  const q = `%${query.toLowerCase()}%`;
  const { results } = await db.prepare(
    `SELECT * FROM meetings WHERE
      LOWER(title) LIKE ?1
      OR LOWER(summary) LIKE ?1
      OR LOWER(key_decisions) LIKE ?1
      OR LOWER(action_items) LIKE ?1
      OR LOWER(participants) LIKE ?1
    ORDER BY date DESC`
  ).bind(q).all();
  return (results || []).map(mapMeetingRow);
}

export async function listMeetings(db: D1Database, dealId?: string): Promise<Meeting[]> {
  if (dealId) {
    const { results } = await db.prepare(
      "SELECT * FROM meetings WHERE deal_id = ?1 ORDER BY date DESC"
    ).bind(dealId).all();
    return (results || []).map(mapMeetingRow);
  }
  const { results } = await db.prepare("SELECT * FROM meetings ORDER BY date DESC").all();
  return (results || []).map(mapMeetingRow);
}

// ── CRM API response helpers (for /api/ routes) ─────────────────────

export async function getDealsForApi(db: D1Database, params: Record<string, string | undefined>) {
  let sql = "SELECT * FROM deals WHERE 1=1";
  const binds: any[] = [];
  let idx = 1;

  if (params.status) { sql += ` AND status = ?${idx}`; binds.push(params.status); idx++; }
  if (params.geo) { sql += ` AND LOWER(geo) = ?${idx}`; binds.push(params.geo.toLowerCase()); idx++; }
  if (params.stage) { sql += ` AND stage = ?${idx}`; binds.push(params.stage); idx++; }
  if (params.source) { sql += ` AND source = ?${idx}`; binds.push(params.source); idx++; }
  if (params.partner) { sql += ` AND LOWER(partner_assigned) = ?${idx}`; binds.push(params.partner.toLowerCase()); idx++; }
  if (params.search) {
    const q = `%${params.search.toLowerCase()}%`;
    sql += ` AND (LOWER(COALESCE(company_name,'')) LIKE ?${idx} OR LOWER(founder_name) LIKE ?${idx} OR LOWER(notes) LIKE ?${idx} OR LOWER(tags) LIKE ?${idx})`;
    binds.push(q); idx++;
  }
  sql += " ORDER BY date_received DESC";

  const stmt = db.prepare(sql);
  const { results } = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();
  return results || [];
}

export async function searchDealsForApi(db: D1Database, q: string) {
  const like = `%${q.toLowerCase()}%`;
  const { results } = await db.prepare(
    `SELECT * FROM deals WHERE
      LOWER(COALESCE(company_name,'')) LIKE ?1
      OR LOWER(founder_name) LIKE ?1
      OR LOWER(notes) LIKE ?1
      OR LOWER(tags) LIKE ?1
      OR LOWER(COALESCE(rejection_reason,'')) LIKE ?1
      OR LOWER(COALESCE(partner_assigned,'')) LIKE ?1
      OR LOWER(source) LIKE ?1
    ORDER BY date_received DESC`
  ).bind(like).all();
  return results || [];
}
