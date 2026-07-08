// Hromadný import registra minimálnej pomoci z IS SEMP (Excel Report15
// „Prijatá minimálna pomoc za posledné 3 roky po podnikoch“).
// Beží raz týždenne v crone; načíta celý register do tabuľky semp_registry,
// aby bolo vyhľadávanie čerpania podľa IČO okamžité (bez živého scrapovania).

const ExcelJS = require('exceljs');
const { pool } = require('./db');

const REPORT_URL = 'https://semp.kti2dc.sk/Static/Report15.xlsx';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) GrantHub/1.0 (+https://granthub.sk)';

const cellNum = (row, i) => {
  const v = row.getCell(i).value;
  if (v == null) return null;
  const n = typeof v === 'object' ? Number(v.result ?? v.text) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const cellText = (row, i) => {
  const v = row.getCell(i).value;
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? '').trim();
  return String(v).trim();
};
// Excel ukladá dátumy ako sériové čísla (dni od 1899-12-30)
function cellDate(row, i) {
  const v = row.getCell(i).value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const n = typeof v === 'number' ? v : (v && typeof v === 'object' ? Number(v.result ?? v.text) : Number(v));
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v && typeof v === 'object' ? (v.text || v.result || '') : v || '');
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const sk = s.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (sk) return `${sk[3]}-${sk[2].padStart(2, '0')}-${sk[1].padStart(2, '0')}`;
  return null;
}

async function runSempBulk(force = false) {
  const { rows: st } = await pool.query(`SELECT value FROM job_state WHERE key = 'semp_bulk_last_run'`);
  if (!force && st.length && Date.now() - new Date(st[0].value).getTime() < 7 * 86400000) {
    return { skipped: true, lastRun: st[0].value };
  }

  const res = await fetch(REPORT_URL, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`SEMP report ${res.status}`);
  const tmp = require('path').join(require('os').tmpdir(), `semp-report-${process.pid}.xlsx`);
  require('fs').writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  // Stlpce: 2=Nazov, 3=ICO, 6=Suma pomoci, 7=Datum, 9=Poskytovatel, 10=Nastroj, 11=NACE, 12=Nariadenie.
  // Firmy su v blokoch: ICO/nazov len na prvom riadku bloku -> forward-fill.
  // Streamovane citanie (52k+ riadkov) — rychle a pamatovo nenarocne.
  const records = [];
  let ico = '';
  let name = '';
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(tmp, { worksheets: 'emit', sharedStrings: 'cache' });
    let rn = 0;
    for await (const ws of reader) {
      for await (const row of ws) {
        rn++;
        if (rn < 9) continue;
        const rowIco = cellText(row, 3).replace(/\D/g, '');
        if (rowIco) { ico = rowIco; name = cellText(row, 2); }
        const amount = cellNum(row, 6);
        const date = cellDate(row, 7);
        if (!ico || amount == null || !date) continue;
        records.push({
          ico, name,
          provider: cellText(row, 9),
          instrument: cellText(row, 10),
          nace: cellText(row, 11),
          regulation: cellText(row, 12),
          amount, date,
        });
      }
      break;
    }
  } finally {
    require('fs').promises.unlink(tmp).catch(() => {});
  }

  // Atomická výmena obsahu tabuľky
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE semp_registry');
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const slice = records.slice(i, i + CHUNK);
      const values = [];
      const ph = slice.map((r, j) => {
        const b = j * 8;
        values.push(r.ico, r.name.slice(0, 200), r.provider.slice(0, 200),
          r.instrument.slice(0, 200), r.nace.slice(0, 120), r.regulation.slice(0, 200),
          r.amount, r.date);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      }).join(',');
      await client.query(
        `INSERT INTO semp_registry (ico, name, provider, instrument, nace, regulation, amount_eur, granted_at) VALUES ${ph}`,
        values);
    }
    await client.query(
      `INSERT INTO job_state (key, value, updated_at) VALUES ('semp_bulk_last_run', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [new Date().toISOString()]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { imported: records.length };
}

// Okamžité vyhľadanie čerpania podľa IČO z lokálnej tabuľky
async function lookupByIco(ico) {
  const clean = String(ico || '').replace(/\D/g, '');
  if (clean.length < 6) return [];
  const { rows } = await pool.query(
    `SELECT * FROM semp_registry WHERE ico = $1 ORDER BY granted_at DESC`, [clean]);
  return rows;
}

module.exports = { runSempBulk, lookupByIco };
