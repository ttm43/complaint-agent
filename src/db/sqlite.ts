import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  received_at TEXT NOT NULL,
  policy_number TEXT,
  claim_id TEXT,
  pds_version TEXT,
  category TEXT,
  category_confidence REAL,
  priority TEXT NOT NULL DEFAULT 'normal',
  scenario_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id TEXT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_by_complaint ON events(complaint_id, seq);
CREATE TABLE IF NOT EXISTS rpa_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  complaint_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  callback_url TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rpa_by_status ON rpa_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  resume_url TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS review_stats (
  category TEXT PRIMARY KEY,
  reviewed INTEGER NOT NULL,
  misclassified INTEGER NOT NULL,
  wrong_citation INTEGER NOT NULL,
  mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retrievals (
  complaint_id TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS training_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id TEXT NOT NULL,
  text TEXT NOT NULL,
  predicted TEXT NOT NULL,
  corrected TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
