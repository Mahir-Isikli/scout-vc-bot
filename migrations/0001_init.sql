-- Scout CRM Database Schema
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  company_name TEXT,
  founder_name TEXT NOT NULL,
  founder_linkedin TEXT,
  stage TEXT NOT NULL DEFAULT 'pre-seed',
  round_size TEXT NOT NULL DEFAULT 'Unknown',
  round_size_eur INTEGER NOT NULL DEFAULT 0,
  geo TEXT NOT NULL DEFAULT 'Unknown',
  status TEXT NOT NULL DEFAULT 'new',
  rejection_reason TEXT,
  partner_assigned TEXT,
  source TEXT NOT NULL DEFAULT 'email',
  date_received TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL DEFAULT 'founder-call',
  key_decisions TEXT NOT NULL DEFAULT '[]',
  action_items TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (deal_id) REFERENCES deals(id)
);

CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_geo ON deals(geo);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_date ON deals(date_received);
CREATE INDEX IF NOT EXISTS idx_meetings_deal ON meetings(deal_id);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
