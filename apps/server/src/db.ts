import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sim_time REAL NOT NULL,
  speed REAL NOT NULL,
  paused INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS corporations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  token TEXT,
  credits REAL NOT NULL,
  reserved_credits REAL NOT NULL DEFAULT 0,
  legacy INTEGER NOT NULL DEFAULT 0,
  created_sim_time REAL NOT NULL,
  last_active_ms INTEGER
);
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  body_id TEXT NOT NULL,
  owner_corp_id TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity_tons REAL NOT NULL,
  listed_tons REAL NOT NULL DEFAULT 0,
  listed_rate REAL,
  ask_price REAL,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  tenant_corp_id TEXT NOT NULL,
  tons REAL NOT NULL,
  rate_per_ton_day REAL NOT NULL,
  accrued_unpaid REAL NOT NULL DEFAULT 0,
  unpaid_since REAL,
  status TEXT NOT NULL,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS containers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  body_id TEXT NOT NULL,
  owner_corp_id TEXT NOT NULL,
  capacity_tons REAL NOT NULL,
  warehouse_id TEXT,
  lease_id TEXT,
  ship_id TEXT
);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  commodity TEXT NOT NULL,
  tons REAL NOT NULL,
  reserved_tons REAL NOT NULL DEFAULT 0,
  UNIQUE(container_id, commodity)
);
CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  body_id TEXT NOT NULL,
  owner_corp_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  ask_price REAL,
  condition REAL NOT NULL DEFAULT 1,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS ships (
  id TEXT PRIMARY KEY,
  owner_corp_id TEXT NOT NULL,
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  state TEXT NOT NULL,
  body_id TEXT NOT NULL,
  dry_mass_tons REAL NOT NULL,
  isp_s REAL NOT NULL,
  tank_tons REAL NOT NULL,
  tank_capacity REAL NOT NULL,
  cargo_capacity REAL NOT NULL,
  crew INTEGER NOT NULL,
  ask_price REAL,
  flight_json TEXT,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  body_id TEXT NOT NULL,
  corp_id TEXT NOT NULL,
  commodity TEXT NOT NULL,
  side TEXT NOT NULL,
  qty_remaining REAL NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL,
  standing_id TEXT,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS standing_orders (
  id TEXT PRIMARY KEY,
  corp_id TEXT NOT NULL,
  body_id TEXT NOT NULL,
  commodity TEXT NOT NULL,
  side TEXT NOT NULL,
  target_tons REAL NOT NULL,
  limit_price REAL NOT NULL,
  batch_tons REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  offer_id TEXT,
  lot_id TEXT,
  corp_id TEXT NOT NULL,
  tons REAL NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  commodity TEXT
);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  from_corp_id TEXT NOT NULL,
  to_corp_id TEXT NOT NULL,
  body_id TEXT NOT NULL,
  credits_offered REAL NOT NULL,
  credits_requested REAL NOT NULL,
  goods_offered_json TEXT NOT NULL,
  goods_requested_json TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_corp_id TEXT NOT NULL,
  to_corp_id TEXT NOT NULL,
  body_id TEXT,
  content TEXT NOT NULL,
  sim_time REAL NOT NULL,
  read_flag INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS constructions (
  id TEXT PRIMARY KEY,
  corp_id TEXT NOT NULL,
  body_id TEXT NOT NULL,
  recipe TEXT NOT NULL,
  completes_at REAL NOT NULL,
  status TEXT NOT NULL,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS space_bids (
  id TEXT PRIMARY KEY,
  corp_id TEXT NOT NULL,
  body_id TEXT NOT NULL,
  tons REAL NOT NULL,
  max_rate REAL NOT NULL,
  status TEXT NOT NULL,
  created_sim_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_time REAL NOT NULL,
  type TEXT NOT NULL,
  corp_id TEXT,
  public INTEGER NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_book ON orders(body_id, commodity, status);
CREATE INDEX IF NOT EXISTS idx_lots_container ON lots(container_id);
CREATE INDEX IF NOT EXISTS idx_events_corp ON events(corp_id, id);
`;

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  // Databases created before tokens and last-active were stored still open.
  if (!hasColumn(db, "corporations", "token")) db.exec("ALTER TABLE corporations ADD COLUMN token TEXT");
  if (!hasColumn(db, "corporations", "last_active_ms")) db.exec("ALTER TABLE corporations ADD COLUMN last_active_ms INTEGER");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_corporations_token ON corporations(token)");
  return db;
}

type SQLValue = string | number | bigint | null | Uint8Array;

export function all<T>(db: DatabaseSync, sql: string, ...params: SQLValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: DatabaseSync, sql: string, ...params: SQLValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: DatabaseSync, sql: string, ...params: SQLValue[]): { changes: number; lastInsertRowid: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}
