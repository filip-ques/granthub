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

    CREATE TABLE IF NOT EXISTS company_contracts (
      id          SERIAL PRIMARY KEY,
      ico         TEXT NOT NULL,
      ext_id      TEXT,
      subject     TEXT NOT NULL DEFAULT '',
      counterparty TEXT NOT NULL DEFAULT '',
      role        TEXT NOT NULL DEFAULT '',
      amount_eur  NUMERIC,
      signed_at   DATE,
      effective_at DATE,
      url         TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_contracts_ico ON company_contracts (ico, signed_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_contracts_ext ON company_contracts (ico, ext_id) WHERE ext_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS company_projects (
      id          SERIAL PRIMARY KEY,
      ico         TEXT NOT NULL,
      ext_id      TEXT,
      code        TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      programme   TEXT NOT NULL DEFAULT '',
      amount_eur  NUMERIC,
      status      TEXT NOT NULL DEFAULT '',
      started_at  DATE,
      url         TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_projects_ico ON company_projects (ico, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_ext ON company_projects (ico, ext_id) WHERE ext_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS company_info (
      ico         TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      address     TEXT NOT NULL DEFAULT '',
      legal_form  TEXT NOT NULL DEFAULT '',
      established DATE,
      source_url  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS semp_registry (
      id          SERIAL PRIMARY KEY,
      ico         TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      provider    TEXT NOT NULL DEFAULT '',
      instrument  TEXT NOT NULL DEFAULT '',
      nace        TEXT NOT NULL DEFAULT '',
      regulation  TEXT NOT NULL DEFAULT '',
      amount_eur  NUMERIC NOT NULL,
      granted_at  DATE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_semp_ico ON semp_registry (ico);

    CREATE TABLE IF NOT EXISTS deminimis_aids (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ico         TEXT NOT NULL,
      provider    TEXT NOT NULL DEFAULT '',
      scheme_code TEXT NOT NULL DEFAULT '',
      note        TEXT,
      amount_eur  NUMERIC NOT NULL,
      granted_at  DATE NOT NULL,
      source      TEXT NOT NULL DEFAULT 'manual',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_deminimis_user ON deminimis_aids (user_id, granted_at DESC);

    -- "Jediný podnik" podľa nariadenia (EÚ) 2023/2831: prepojené firmy zdieľajú jeden limit
    CREATE TABLE IF NOT EXISTS deminimis_linked (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ico        TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      relation   TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, ico)
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER NOT NULL DEFAULT 0,
      ip          TEXT NOT NULL DEFAULT '',
      user_agent  TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_activity_time ON activity_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_activity_user ON activity_events (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS spam_events (
      id          SERIAL PRIMARY KEY,
      path        TEXT NOT NULL,
      reason      TEXT NOT NULL,
      ip          TEXT NOT NULL DEFAULT '',
      user_agent  TEXT NOT NULL DEFAULT '',
      payload     TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_spam_time ON spam_events (created_at DESC);

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
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS ai_title TEXT`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS ai_teaser TEXT`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS ai_details JSONB`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS ai_details_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE radar_subscriptions ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS code TEXT`);
  await pool.query(`ALTER TABLE radar_subscriptions ADD COLUMN IF NOT EXISTS tender_industries TEXT`);
  await pool.query(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS ai_summary TEXT`);
  await pool.query(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS ai_points TEXT`);
  await pool.query(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS ai_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE saved_tendre ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'watch'`);
  await pool.query(`ALTER TABLE saved_tendre ADD COLUMN IF NOT EXISTS note TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE deminimis_aids ADD COLUMN IF NOT EXISTS ext_id TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS semp_refreshed_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_deminimis_ext ON deminimis_aids (user_id, ext_id) WHERE ext_id IS NOT NULL`);
  await pool.query(`ALTER TABLE vyzvy ADD COLUMN IF NOT EXISTS announced DATE`);

  // ---------- Obstarávanie (procurement) ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subory (
      id         SERIAL PRIMARY KEY,
      nazov      TEXT NOT NULL,
      mime       TEXT NOT NULL DEFAULT '',
      velkost    INTEGER NOT NULL DEFAULT 0,
      data       BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS obstaravania (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nazov       TEXT NOT NULL,
      popis       TEXT NOT NULL DEFAULT '',
      rozpocet    NUMERIC,
      termin_ponuky TIMESTAMPTZ,
      stav        TEXT NOT NULL DEFAULT 'priprava',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_obst_user ON obstaravania (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS obstaravanie_podklady (
      id               SERIAL PRIMARY KEY,
      obstaravanie_id  INTEGER NOT NULL REFERENCES obstaravania(id) ON DELETE CASCADE,
      subor_id         INTEGER NOT NULL REFERENCES subory(id) ON DELETE CASCADE,
      kategoria        TEXT NOT NULL DEFAULT 'ine',
      popis            TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS obstaravanie_kola (
      id              SERIAL PRIMARY KEY,
      obstaravanie_id INTEGER NOT NULL REFERENCES obstaravania(id) ON DELETE CASCADE,
      cislo           INTEGER NOT NULL DEFAULT 1,
      termin          TIMESTAMPTZ,
      stav            TEXT NOT NULL DEFAULT 'otvorene',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS obstaravanie_dodavatelia (
      id              SERIAL PRIMARY KEY,
      obstaravanie_id INTEGER NOT NULL REFERENCES obstaravania(id) ON DELETE CASCADE,
      email           TEXT NOT NULL,
      nazov           TEXT NOT NULL DEFAULT '',
      token           TEXT UNIQUE NOT NULL,
      stav            TEXT NOT NULL DEFAULT 'pozvany',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS obstaravanie_ponuky (
      id            SERIAL PRIMARY KEY,
      kolo_id       INTEGER NOT NULL REFERENCES obstaravanie_kola(id) ON DELETE CASCADE,
      dodavatel_id  INTEGER NOT NULL REFERENCES obstaravanie_dodavatelia(id) ON DELETE CASCADE,
      suma          NUMERIC,
      poznamka      TEXT NOT NULL DEFAULT '',
      stav          TEXT NOT NULL DEFAULT 'dorucena',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (kolo_id, dodavatel_id)
    );

    CREATE TABLE IF NOT EXISTS obstaravanie_ponuka_subory (
      ponuka_id INTEGER NOT NULL REFERENCES obstaravanie_ponuky(id) ON DELETE CASCADE,
      subor_id  INTEGER NOT NULL REFERENCES subory(id) ON DELETE CASCADE,
      PRIMARY KEY (ponuka_id, subor_id)
    );

    CREATE TABLE IF NOT EXISTS obstaravanie_spravy (
      id           SERIAL PRIMARY KEY,
      dodavatel_id INTEGER NOT NULL REFERENCES obstaravanie_dodavatelia(id) ON DELETE CASCADE,
      smer         TEXT NOT NULL DEFAULT 'obstaravatel',
      text         TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, init };
