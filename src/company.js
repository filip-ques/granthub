// Verejné údaje firmy podľa IČO do profilu:
//  - RPO (Štatistický úrad, JSON, bez auth): základné údaje firmy
//  - CRZ (Centrálny register zmlúv, HTML scrape): verejné zmluvy firmy
//  - ITMS2014+ (eurofondové projekty): ošetrené, keď je API dostupné
// Aktualizuje sa raz týždenne na pozadí; stránka číta z lokálnych tabuliek → okamžite.

const cheerio = require('cheerio');
const { pool } = require('./db');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) GrantHub/1.0 (+https://granthub.sk)';

function parseSkMoney(s) {
  const n = Number(String(s).replace(/ |\s/g, '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const SK_MONTHS = {
  'január': 1, 'februar': 2, 'február': 2, 'marec': 3, 'apríl': 4, 'apríl ': 4,
  'máj': 5, 'jún': 6, 'júl': 7, 'august': 8, 'september': 9,
  'október': 10, 'november': 11, 'december': 12,
};
function parseSkLongDate(s) {
  const m = String(s).toLowerCase().match(/(\d{1,2})\.?\s+([a-zá-ž]+)\s+(\d{4})/);
  if (!m) return null;
  const mon = SK_MONTHS[m[2]];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ---------- RPO: základné údaje firmy ----------
async function fetchRpo(ico) {
  const res = await fetch(`https://api.statistics.sk/rpo/v1/search?identifier=${encodeURIComponent(ico)}`,
    { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`RPO ${res.status}`);
  const data = await res.json();
  const r = (data.results || [])[0];
  if (!r) return null;
  const a = (r.addresses || [])[0] || {};
  const addr = [
    [a.street, a.buildingNumber].filter(Boolean).join(' '),
    [(a.postalCodes || [])[0], (a.municipality || {}).value].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return {
    ico: String(ico),
    name: (r.fullNames && r.fullNames[0] && r.fullNames[0].value) || '',
    address: addr,
    legal_form: (r.sourceRegister && r.sourceRegister.value && r.sourceRegister.value.value) || '',
    established: r.establishment || null,
    source_url: `https://api.statistics.sk/rpo/v1/search?identifier=${ico}`,
  };
}

// ---------- CRZ: verejné zmluvy ----------
async function fetchCrzContracts(ico, firmName = '', maxPages = 3) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `https://www.crz.gov.sk/vysledky-vyhladavania/?art_ico=${encodeURIComponent(ico)}&page=${page}`;
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) break;
    const $ = cheerio.load(await res.text());
    const rows = $('table tr').toArray();
    let pageCount = 0;
    for (const tr of rows) {
      const tds = $(tr).find('td');
      if (tds.length < 5) continue;
      const link = $(tr).find('a[href*="/zmluva/"]').first().attr('href');
      const extId = link && (link.match(/\/zmluva\/(\d+)/) || [])[1];
      const subject = $(tds[1]).text().replace(/\s+/g, ' ').trim();
      const supplier = $(tds[3]).text().replace(/\s+/g, ' ').trim();
      const customer = $(tds[4]).text().replace(/\s+/g, ' ').trim();
      const amount = parseSkMoney($(tds[2]).text());
      const signed = parseSkLongDate($(tds[0]).text());
      if (!subject) continue;
      // firma je jedna zo strán — protistrana je tá druhá
      const fn = firmName.toLowerCase().slice(0, 12);
      const firmIsSupplier = fn && supplier.toLowerCase().includes(fn);
      out.push({
        ico: String(ico), ext_id: extId || null, subject,
        counterparty: firmIsSupplier ? customer : supplier,
        role: firmIsSupplier ? 'dodávateľ' : 'objednávateľ',
        amount_eur: amount, signed_at: signed,
        url: link ? `https://www.crz.gov.sk${link}` : null,
      });
      pageCount++;
    }
    if (pageCount < 20) break; // posledná strana
  }
  return out;
}

// ---------- ITMS: eurofondové projekty (ošetrené) ----------
async function fetchItmsProjects(ico) {
  const API = 'https://opendata.itms2014.sk';
  try {
    const sres = await fetch(`${API}/v2/subjekty?ico=${encodeURIComponent(ico)}&limit=5`,
      { headers: { accept: 'application/json', 'user-agent': UA } });
    if (!sres.ok) return [];
    const subs = await sres.json();
    const subjIds = (Array.isArray(subs) ? subs : []).map((s) => s.id).filter(Boolean);
    if (!subjIds.length) return [];
    // projekty prijímateľa
    const out = [];
    const pres = await fetch(`${API}/v2/projekty?limit=100000`,
      { headers: { accept: 'application/json', 'user-agent': UA } });
    if (!pres.ok) return [];
    const projekty = await pres.json();
    for (const p of (Array.isArray(projekty) ? projekty : [])) {
      const recip = p.prijimatel && p.prijimatel.id;
      if (!subjIds.includes(recip)) continue;
      out.push({
        ico: String(ico), ext_id: `itms-p-${p.id}`,
        code: p.kod || '', title: p.nazov || '',
        programme: 'Eurofondy (ITMS)',
        amount_eur: p.zmluvnyUdajZazmluvnene || p.schvalenaVyskaNfp || null,
        status: p.stav || '', started_at: p.datumZacatiaRealizacie ? String(p.datumZacatiaRealizacie).slice(0, 10) : null,
        url: `${API}/v2/projekt/${p.id}`,
      });
      if (out.length >= 100) break;
    }
    return out;
  } catch {
    return []; // API dočasne nedostupné — preskoč, skúsi sa o týždeň
  }
}

// ---------- Naplnenie pre jedno IČO ----------
async function importCompany(ico) {
  const clean = String(ico || '').replace(/\D/g, '');
  if (clean.length < 6) return { skipped: true };

  const info = await fetchRpo(clean).catch(() => null);
  if (info) {
    await pool.query(
      `INSERT INTO company_info (ico, name, address, legal_form, established, source_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (ico) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address,
         legal_form=EXCLUDED.legal_form, established=EXCLUDED.established, updated_at=now()`,
      [clean, info.name, info.address, info.legal_form, info.established, info.source_url]);
  }

  const contracts = await fetchCrzContracts(clean, info ? info.name : '').catch(() => []);
  let c = 0;
  for (const z of contracts) {
    const r = await pool.query(
      `INSERT INTO company_contracts (ico, ext_id, subject, counterparty, role, amount_eur, signed_at, url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ico, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
         subject=EXCLUDED.subject, counterparty=EXCLUDED.counterparty, role=EXCLUDED.role,
         amount_eur=EXCLUDED.amount_eur, signed_at=EXCLUDED.signed_at, url=EXCLUDED.url
       RETURNING (xmax=0) AS ins`,
      [z.ico, z.ext_id, z.subject.slice(0, 300), z.counterparty.slice(0, 200), z.role, z.amount_eur, z.signed_at, z.url]);
    if (r.rows[0].ins) c++;
  }

  const projects = await fetchItmsProjects(clean).catch(() => []);
  let p = 0;
  for (const pr of projects) {
    const r = await pool.query(
      `INSERT INTO company_projects (ico, ext_id, code, title, programme, amount_eur, status, started_at, url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (ico, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
         title=EXCLUDED.title, amount_eur=EXCLUDED.amount_eur, status=EXCLUDED.status
       RETURNING (xmax=0) AS ins`,
      [pr.ico, pr.ext_id, pr.code.slice(0, 60), pr.title.slice(0, 300), pr.programme, pr.amount_eur, pr.status.slice(0, 60), pr.started_at, pr.url]);
    if (r.rows[0].ins) p++;
  }

  return { info: !!info, contracts: contracts.length, newContracts: c, projects: projects.length, newProjects: p };
}

// Cron: obnov firmy všetkých IČO používateľov raz týždenne
async function runCompanyRefresh(force = false) {
  const { rows: st } = await pool.query(`SELECT value FROM job_state WHERE key = 'company_last_run'`);
  if (!force && st.length && Date.now() - new Date(st[0].value).getTime() < 7 * 86400000) {
    return { skipped: true, lastRun: st[0].value };
  }
  const { rows: icos } = await pool.query(
    `SELECT DISTINCT ico FROM users WHERE ico IS NOT NULL AND ico <> ''`);
  const out = { icos: 0, contracts: 0, projects: 0 };
  for (const { ico } of icos) {
    try {
      const r = await importCompany(ico);
      out.icos++; out.contracts += r.newContracts || 0; out.projects += r.newProjects || 0;
    } catch (e) { console.error('[company]', ico, e.message); }
    await new Promise((r) => setTimeout(r, 500));
  }
  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('company_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [new Date().toISOString()]);
  return out;
}

module.exports = { importCompany, runCompanyRefresh, fetchRpo };
