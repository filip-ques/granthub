// Spoločné utility pre scrapery grantových zdrojov (FPU, Envirofond, Plán obnovy).
// Ukladajú sa len fakty: názov, termíny, alokácia, oficiálny odkaz. Popisy sú
// krátke vlastné zhrnutia, nie prevzaté texty zdrojov.

const { pool } = require('../db');

const UA = 'GrantHub/1.0 (+https://granthub.sk; agregátor verejných výziev)';

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function slugify(s, prefix) {
  const base = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 70);
  return `${prefix}-${base}`;
}

// Slovenské dátumy: 31. 12. 2026, 31.12.2026, 2026-12-31
function parseSkDate(s) {
  if (!s) return null;
  const iso = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = String(s).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

// Sumy: "1 500 000 €", "1,5 mil. eur"
function parseEur(s) {
  if (!s) return null;
  const mil = String(s).match(/([\d.,]+)\s*mil/i);
  if (mil) return Math.round(parseFloat(mil[1].replace(',', '.')) * 1e6);
  const m = String(s).replace(/[  ]/g, '').match(/([\d][\d\s.,]{2,})\s*(€|eur)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Upsertne zoskrejpované výzvy pre daný zdroj a uzavrie tie, ktoré zo zdroja zmizli.
 * @param {string} source - značka zdroja (fpu | envirofond | planobnovy)
 * @param {Array} items - [{ slug, title, provider, program, category, applicants,
 *                           regions, amount_min, amount_max, allocation, deadline,
 *                           deadline_note, summary, details, source_url }]
 */
async function upsertVyzvy(source, items) {
  let inserted = 0;
  let updated = 0;
  for (const v of items) {
    const res = await pool.query(
      `INSERT INTO vyzvy (slug, title, provider, program, category, applicants, regions,
                          amount_min, amount_max, allocation, deadline, deadline_note,
                          summary, details, source_url, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'otvorena',$16)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, provider = EXCLUDED.provider, program = EXCLUDED.program,
         category = EXCLUDED.category, applicants = EXCLUDED.applicants,
         amount_min = EXCLUDED.amount_min, amount_max = EXCLUDED.amount_max,
         allocation = EXCLUDED.allocation, deadline = EXCLUDED.deadline,
         deadline_note = EXCLUDED.deadline_note, summary = EXCLUDED.summary,
         details = EXCLUDED.details, source_url = EXCLUDED.source_url, status = 'otvorena'
       RETURNING (xmax = 0) AS inserted`,
      [v.slug, v.title, v.provider, v.program || null, v.category,
       v.applicants || 'podľa dokumentácie výzvy', v.regions || 'Celé Slovensko',
       v.amount_min ?? null, v.amount_max ?? null, v.allocation ?? null,
       v.deadline ?? null, v.deadline_note ?? null, v.summary, v.details ?? null,
       v.source_url, source]
    );
    if (res.rows[0].inserted) inserted++; else updated++;
  }
  let closed = 0;
  if (items.length) {
    const { rowCount } = await pool.query(
      `UPDATE vyzvy SET status = 'uzavreta'
       WHERE source = $1 AND status = 'otvorena' AND NOT (slug = ANY($2))`,
      [source, items.map((v) => v.slug)]
    );
    closed = rowCount;
  }
  return { inserted, updated, closed, total: items.length };
}

module.exports = { fetchHtml, fetchJson, slugify, parseSkDate, parseEur, upsertVyzvy, UA };
