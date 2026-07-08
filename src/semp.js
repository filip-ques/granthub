// IS SEMP (semp.kti2dc.sk) — verejné vyhľadávanie poskytnutej minimálnej pomoci podľa IČO.
// Server-rendered HTML, bez prihlásenia. Berieme register minimálnej pomoci (Psecond=true).

const cheerio = require('cheerio');
const { pool } = require('./db');

const BASE = 'https://semp.kti2dc.sk';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) GrantHub/1.0 (+https://granthub.sk)';

function parseEur(s) {
  const n = Number(String(s).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function parseSkDate(s) {
  const m = String(s).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  return m ? `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null;
}

// Vráti záznamy minimálnej pomoci pre IČO z registra SEMP
async function fetchAidsByIco(ico) {
  const records = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${BASE}/Search?Text=${encodeURIComponent(ico)}&SearchCategory=Pripady&Pfirst=true&Psecond=true&page=${page}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`SEMP ${res.status}`);
    const $ = cheerio.load(await res.text());
    // Každý záznam = 2 riadky: (identifikátor, schéma, pomoc, typ) + (poskytovateľ, príjemca, suma, dátum, stav)
    const rows = $('table tr').toArray();
    let pageRecords = 0;
    let head = null;
    for (const tr of rows) {
      const cells = $(tr).find('td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
      if (!cells.length) continue;
      if (/^(MP|SP)-P-/.test(cells[0])) {
        head = { ext_id: cells[0], scheme: cells[1] || '' };
        continue;
      }
      if (head && cells.length >= 5) {
        const rec = {
          ...head,
          provider: cells[0],
          recipient: cells[1],
          amount: parseEur(cells[2]),
          granted_at: parseSkDate(cells[3]),
          status: cells[4],
        };
        head = null;
        if (rec.amount != null && rec.granted_at) { records.push(rec); pageRecords++; }
      }
    }
    if (pageRecords < 10) break;
  }
  return records;
}

// Upsert záznamov z registra pre používateľa (source='semp', dedup cez ext_id)
async function importForUser(userId, ico) {
  const recs = await fetchAidsByIco(ico);
  // do kalkulačky len minimálna pomoc (MP-P-*); štátna pomoc (SP-P-*) sa do limitu nepočíta
  const approved = recs.filter((r) => /^MP-/i.test(r.ext_id) && /schválen/i.test(r.status));
  let imported = 0;
  for (const r of approved) {
    const res = await pool.query(
      `INSERT INTO deminimis_aids (user_id, ico, provider, scheme_code, note, amount_eur, granted_at, source, ext_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'semp',$8)
       ON CONFLICT (user_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
         amount_eur = EXCLUDED.amount_eur, granted_at = EXCLUDED.granted_at,
         provider = EXCLUDED.provider, scheme_code = EXCLUDED.scheme_code
       RETURNING (xmax = 0) AS ins`,
      [userId, ico, r.provider.slice(0, 200), r.scheme.slice(0, 200),
       `register SEMP · ${r.recipient}`.slice(0, 300), r.amount, r.granted_at, r.ext_id]);
    if (res.rows[0].ins) imported++;
  }
  return { found: recs.length, approved: approved.length, imported };
}

// Cron: obnov SEMP záznamy všetkých sledovaných IČO raz za 21 dní
async function runSempRefresh(force = false) {
  const { rows: st } = await pool.query(`SELECT value FROM job_state WHERE key = 'semp_last_run'`);
  if (!force && st.length && Date.now() - new Date(st[0].value).getTime() < 21 * 86400000) {
    return { skipped: true, lastRun: st[0].value };
  }
  const { rows: pairs } = await pool.query(
    `SELECT DISTINCT user_id, ico FROM deminimis_aids WHERE source = 'semp' AND ico <> ''
     UNION SELECT id AS user_id, ico FROM users WHERE ico IS NOT NULL AND ico <> ''`);
  const out = { refreshedIcos: 0, imported: 0 };
  for (const p of pairs) {
    try {
      const r = await importForUser(p.user_id, p.ico);
      out.refreshedIcos++; out.imported += r.imported;
    } catch (e) { console.error('[semp]', p.ico, e.message); }
    await new Promise((r) => setTimeout(r, 800));
  }
  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('semp_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [new Date().toISOString()]);
  return out;
}

module.exports = { fetchAidsByIco, importForUser, runSempRefresh };
