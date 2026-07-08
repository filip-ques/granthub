// Ingest verejných zákaziek z oficiálneho TED Search API v3 (api.ted.europa.eu).
// Verejný endpoint bez API kľúča. Portované z itender-radar (app/ingest/ted.py).

const { pool } = require('./db');
const { normalizeRegion, industryForCpv, foldText } = require('./tender-catalog');

const TED_API_URL = process.env.TED_API_URL || 'https://api.ted.europa.eu/v3/notices/search';
const COUNTRY = process.env.TENDER_COUNTRY || 'SVK';
const MAX_PAGES = Number(process.env.TENDER_MAX_PAGES || 10);
const PAGE_SIZE = Number(process.env.TENDER_PAGE_SIZE || 100);

const FIELDS = [
  'publication-number',
  'notice-title',
  'description-lot',
  'buyer-name',
  'place-of-performance',
  'classification-cpv',
  'notice-type',
  'procedure-type',
  'publication-date',
  'deadline-receipt-tender-date-lot',
  'total-value',
  'links',
];

// TED viacjazyčné polia sú tvaru {slk: ["..."], eng: ["..."]}
function pickLang(value, prefer = ['slk', 'eng', 'ces']) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) { const s = pickLang(item, prefer); if (s) return s; }
    return '';
  }
  if (typeof value === 'object') {
    for (const lang of prefer) if (value[lang]) { const s = pickLang(value[lang], prefer); if (s) return s; }
    for (const v of Object.values(value)) { const s = pickLang(v, prefer); if (s) return s; }
    return '';
  }
  return String(value);
}

// eForms tituly majú prefix „Slovensko – kategória – názov“
function cleanTitle(title) {
  if (!title) return '';
  let t = title.trim();
  for (const sep of [' – ', ' - ', ' — ']) {
    if (t.startsWith('Slovensko' + sep)) return t.slice(('Slovensko' + sep).length).trim();
  }
  return t;
}

const first = (v) => (Array.isArray(v) ? v[0] ?? null : v);

function parseDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseDeadline(v) {
  v = first(v);
  if (!v) return null;
  const s = String(v);
  // TED formát býva „2026-08-07+02:00" (dátum + offset bez času) — ber koniec dňa
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})(?![T\d])/);
  const iso = dateOnly ? `${dateOnly[1]}T23:59:00` : s.replace('Z', '+00:00');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseValue(v) {
  v = first(v);
  if (v && typeof v === 'object') v = v.amount ?? v.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const langLink = (obj) => (obj && (obj.SLK || obj.ENG || Object.values(obj)[0])) || '';

function mapNotice(n) {
  const ext = n['publication-number'];
  if (!ext) return null;
  // TED vracia jedno CPV na lot — deduplikuj so zachovaním poradia
  const cpv = [...new Set((n['classification-cpv'] || []).filter(Boolean).map(String))];
  const region = normalizeRegion(first(n['place-of-performance']) || '');
  const links = n.links || {};
  const title = cleanTitle(pickLang(n['notice-title'])) || `Oznámenie ${ext}`;
  const buyer = (pickLang(n['buyer-name']) || '').slice(0, 500);
  const description = (pickLang(n['description-lot']) || '').slice(0, 6000);
  return {
    external_id: String(ext),
    title: title.slice(0, 1000),
    buyer_name: buyer,
    description,
    search_blob: foldText(`${title} ${buyer} ${description}`),
    notice_type: n['notice-type'] || '',
    procedure_type: first(n['procedure-type']) || '',
    cpv_codes: cpv,
    main_cpv: cpv[0] || '',
    industry: industryForCpv(cpv),
    region_code: region.code,
    region_name: region.name,
    value_eur: parseValue(n['total-value']),
    publication_date: parseDate(first(n['publication-date'])),
    deadline: parseDeadline(n['deadline-receipt-tender-date-lot']),
    source_url: langLink(links.html),
    documents_url: langLink(links.pdf),
  };
}

async function fetchPage(page) {
  const body = {
    query: `place-of-performance IN (${COUNTRY}) SORT BY publication-date DESC`,
    fields: FIELDS,
    limit: PAGE_SIZE,
    page,
    scope: 'ACTIVE',
    paginationMode: 'PAGE_NUMBER',
    onlyLatestVersions: true,
    checkQuerySyntax: false,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(TED_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'GrantHub/1.0 (+https://granthub.sk)' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`TED API ${res.status}`);
    const data = await res.json();
    return { notices: data.notices || [], total: Number(data.totalNoticeCount || 0) };
  }
  return { notices: [], total: 0 };
}

async function runTenderIngest() {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let notices;
    try {
      ({ notices, total } = await fetchPage(page));
    } catch (e) {
      console.error(`[tendre] strana ${page} zlyhala:`, e.message);
      break;
    }
    if (!notices.length) break;

    for (const n of notices) {
      const t = mapNotice(n);
      if (!t) { skipped++; continue; }
      const res = await pool.query(
        `INSERT INTO tenders (external_id, title, buyer_name, description, search_blob,
                              notice_type, procedure_type, cpv_codes, main_cpv, industry,
                              region_code, region_name, value_eur, publication_date, deadline,
                              source_url, documents_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (external_id) DO UPDATE SET
           title = EXCLUDED.title, buyer_name = EXCLUDED.buyer_name,
           description = EXCLUDED.description, search_blob = EXCLUDED.search_blob,
           notice_type = EXCLUDED.notice_type, procedure_type = EXCLUDED.procedure_type,
           cpv_codes = EXCLUDED.cpv_codes, main_cpv = EXCLUDED.main_cpv,
           industry = EXCLUDED.industry, region_code = EXCLUDED.region_code,
           region_name = EXCLUDED.region_name, value_eur = EXCLUDED.value_eur,
           publication_date = EXCLUDED.publication_date, deadline = EXCLUDED.deadline,
           source_url = EXCLUDED.source_url, documents_url = EXCLUDED.documents_url
         RETURNING (xmax = 0) AS inserted`,
        [t.external_id, t.title, t.buyer_name, t.description, t.search_blob,
         t.notice_type, t.procedure_type, JSON.stringify(t.cpv_codes), t.main_cpv, t.industry,
         t.region_code, t.region_name, t.value_eur, t.publication_date, t.deadline,
         t.source_url, t.documents_url]
      );
      if (res.rows[0].inserted) inserted++; else updated++;
    }
    if (notices.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 600)); // šetrnosť k verejnému API
  }

  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('tender_ingest_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [new Date().toISOString()]
  );

  return { sourceTotal: total, inserted, updated, skipped };
}

module.exports = { runTenderIngest };
