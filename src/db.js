const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://postgres:devpass@localhost:5433/grantexpert';

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : false,
  max: 10,
});

// Beh v zdieľanom Postgres serveri: vlastná schéma (napr. granthub) cez DATABASE_SCHEMA.
// Pooler (PgBouncer) beží v session móde, takže SET per pripojenie drží.
const schema = process.env.DATABASE_SCHEMA;
if (schema && /^[a-z_][a-z0-9_]*$/.test(schema)) {
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${schema}, public`).catch((e) =>
      console.error('search_path zlyhal:', e.message));
  });
}

async function init() {
  if (schema && /^[a-z_][a-z0-9_]*$/.test(schema)) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      name       TEXT,
      company    TEXT,
      ico        TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS login_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS vyzvy (
      id            SERIAL PRIMARY KEY,
      slug          TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      provider      TEXT,
      program       TEXT,
      category      TEXT NOT NULL,
      applicants    TEXT NOT NULL,
      regions       TEXT NOT NULL DEFAULT 'Celé Slovensko',
      amount_min    NUMERIC,
      amount_max    NUMERIC,
      allocation    NUMERIC,
      deadline      DATE,
      deadline_note TEXT,
      summary       TEXT NOT NULL,
      details       TEXT,
      source_url    TEXT,
      status        TEXT NOT NULL DEFAULT 'otvorena',
      source        TEXT NOT NULL DEFAULT 'manual',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS saved_vyzvy (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vyzva_id INTEGER NOT NULL REFERENCES vyzvy(id) ON DELETE CASCADE,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, vyzva_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      service    TEXT NOT NULL,
      vyzva_id   INTEGER REFERENCES vyzvy(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      phone      TEXT,
      company    TEXT,
      ico        TEXT,
      message    TEXT,
      status     TEXT NOT NULL DEFAULT 'nova',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS job_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tenders (
      id               SERIAL PRIMARY KEY,
      external_id      TEXT UNIQUE NOT NULL,
      title            TEXT NOT NULL,
      buyer_name       TEXT NOT NULL DEFAULT '',
      description      TEXT NOT NULL DEFAULT '',
      search_blob      TEXT NOT NULL DEFAULT '',
      notice_type      TEXT NOT NULL DEFAULT '',
      procedure_type   TEXT NOT NULL DEFAULT '',
      cpv_codes        JSONB,
      main_cpv         TEXT NOT NULL DEFAULT '',
      industry         TEXT NOT NULL DEFAULT 'ostatne',
      region_code      TEXT NOT NULL DEFAULT '',
      region_name      TEXT NOT NULL DEFAULT '',
      value_eur        NUMERIC,
      publication_date DATE,
      deadline         TIMESTAMPTZ,
      source_url       TEXT NOT NULL DEFAULT '',
      documents_url    TEXT NOT NULL DEFAULT '',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS ix_tenders_filter ON tenders (industry, region_code, deadline);
    CREATE INDEX IF NOT EXISTS ix_tenders_pub ON tenders (publication_date DESC);

    CREATE TABLE IF NOT EXISTS saved_tendre (
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
      stage     TEXT NOT NULL DEFAULT 'watch',
      note      TEXT,
      saved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, tender_id)
    );

    CREATE TABLE IF NOT EXISTS tender_searches (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      q           TEXT NOT NULL DEFAULT '',
      industry    TEXT NOT NULL DEFAULT '',
      region_code TEXT NOT NULL DEFAULT '',
      cpv         TEXT NOT NULL DEFAULT '',
      min_value   NUMERIC,
      notify      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS products (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      keywords     TEXT NOT NULL DEFAULT '',
      cpv_prefixes TEXT NOT NULL DEFAULT '',
      active       BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS radar_subscriptions (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      categories TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (email)
    );
  `);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS links JSONB`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS contacts JSONB`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS objectives TEXT`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS fund TEXT`);
  await pool.query(`ALTER TABLE radar_subscriptions ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS code TEXT`);
  await pool.query(`ALTER TABLE radar_subscriptions ADD COLUMN IF NOT EXISTS tender_industries TEXT`);
  await pool.query(`ALTER TABLE saved_tendre ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'watch'`);
  await pool.query(`ALTER TABLE saved_tendre ADD COLUMN IF NOT EXISTS note TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS announced DATE`);
}

module.exports = { pool, init };
