import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

/**
 * Connects to Supabase's Postgres database. Set DATABASE_URL to your Supabase
 * connection string (Project Settings → Database → Connection string → "Transaction"
 * pooler mode is recommended for serverless/Netlify Functions — see README).
 *
 * There is no local/offline fallback here on purpose: Supabase's free tier is
 * generous enough to use for local development too, so both `bun run dev` and the
 * deployed Netlify site can point at the same project (or two different Supabase
 * projects — dev and prod — if you prefer). Either way, set DATABASE_URL before
 * running the app; see .env.example.
 */
const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill in your Supabase connection string " +
      "(Project Settings → Database → Connection string), or set DATABASE_URL in your Netlify environment variables.",
  );
}

// `prepare: false` is required for Supabase's "Transaction" pooler (pgbouncer in
// transaction mode doesn't support prepared statements) — safe to leave on even if
// you're using the "Session" pooler or a direct connection.
const client = postgres(url, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };

// --- Schema bootstrap -------------------------------------------------
// No separate migration step to run before deploying: the tables are created
// (IF NOT EXISTS) the first time the app talks to the database, so a brand-new
// empty Supabase project just works. Re-running this on every boot is a no-op
// once the tables exist. (`drizzle-kit` is still available for anyone who
// prefers explicit migrations later — see drizzle.config.ts.)
let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await client`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY DEFAULT 1,
          institution_name TEXT NOT NULL,
          institution_campus TEXT NOT NULL,
          institution_department TEXT NOT NULL,
          institution_address TEXT NOT NULL,
          institution_contact TEXT NOT NULL,
          institution_term TEXT NOT NULL,
          institution_year TEXT NOT NULL,
          admin_password_hash TEXT NOT NULL
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS grade_bands (
          id TEXT PRIMARY KEY,
          min REAL NOT NULL,
          max REAL NOT NULL,
          point REAL NOT NULL,
          label TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS classes (
          id TEXT PRIMARY KEY,
          programme TEXT NOT NULL,
          module_label TEXT NOT NULL,
          teacher_group TEXT NOT NULL,
          period TEXT
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS units (
          id TEXT PRIMARY KEY,
          class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          max_c1 REAL NOT NULL DEFAULT 0,
          max_c2 REAL NOT NULL DEFAULT 0,
          max_a REAL NOT NULL DEFAULT 0,
          max_e REAL NOT NULL DEFAULT 0,
          is_common BOOLEAN NOT NULL DEFAULT false
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS students (
          id TEXT PRIMARY KEY,
          class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
          adm_no TEXT NOT NULL,
          name TEXT NOT NULL
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS marks (
          unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          c1 REAL, c2 REAL, a REAL, e REAL,
          entered_by TEXT, entered_at TEXT,
          PRIMARY KEY (unit_id, student_id)
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS mocks (
          unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          score REAL,
          entered_by TEXT, entered_at TEXT,
          PRIMARY KEY (unit_id, student_id)
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS teachers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'teacher',
          department TEXT
        )
      `;
      await client`
        CREATE TABLE IF NOT EXISTS teacher_classes (
          teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
          class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
          PRIMARY KEY (teacher_id, class_id)
        )
      `;
    })();
  }
  return schemaReady;
}
