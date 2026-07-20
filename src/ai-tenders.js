// AI rozpis verejných zákaziek (tendrov) z textu TED oznámenia.
// Vytvorí vecné slovenské zhrnutie + kľúčové body z popisu a parametrov oznámenia.
// Používa VÝHRADNE dodané fakty (žiadne vymýšľanie).

const { pool } = require('./db');
const { cpvLabel } = require('./tender-catalog');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

function factsFor(t) {
  const cpvs = (t.cpv_codes || []).slice(0, 6).map((c) => `${c} (${cpvLabel(c)})`).join(', ');
  return [
    `Názov: ${t.title}`,
    t.buyer_name ? `Obstarávateľ: ${t.buyer_name}` : null,
    t.value_eur ? `Predpokladaná hodnota: ${Number(t.value_eur).toLocaleString('sk-SK')} €` : null,
    t.region_name ? `Miesto plnenia: ${t.region_name}` : null,
    cpvs ? `CPV: ${cpvs}` : null,
    t.deadline ? `Lehota na predloženie: ${new Date(t.deadline).toLocaleDateString('sk-SK')}` : null,
    t.description ? `Opis predmetu:\n${String(t.description).slice(0, 5000)}` : null,
  ].filter(Boolean).join('\n');
}

const SYSTEM = `Si odborný editor slovenského portálu o verejných zákazkách. Z DODANÝCH FAKTOV o zákazke vytvor vecný prehľad v spisovnej slovenčine, VLASTNÝMI SLOVAMI (nie doslovná kópia).
Vráť IBA čistý JSON:
{
 "summary": "2-4 vety: čo obstarávateľ obstaráva a na aký účel",
 "points": "3-6 kľúčových bodov (predmet, rozsah, miesto, hodnota, lehota, čo je dôležité) — oddelené znakom |"
}
PRAVIDLÁ: Používaj VÝHRADNE dodané fakty. Nič si nevymýšľaj (rozsah, podmienky, sumy neuhádni). Ak je opis v cudzom jazyku, zhrň ho po slovensky. Vráť len JSON.`;

async function generateTender(t) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY chýba');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 700, system: SYSTEM,
      messages: [{ role: 'user', content: `Fakty o zákazke:\n${factsFor(t)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  const text = (data.content || [])[0] && data.content[0].text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const out = JSON.parse(m[0]);
  if (!out.summary || String(out.summary).trim().length < 20) return null;
  return { summary: String(out.summary).trim().slice(0, 800), points: String(out.points || '').trim().slice(0, 1000) };
}

async function runAiTenders(limit = 40) {
  if (!API_KEY) return { skipped: 'no_api_key' };
  // len otvorené zákazky s dostatočným popisom, bez rozpisu
  const { rows } = await pool.query(
    `SELECT * FROM tenders WHERE (deadline IS NULL OR deadline >= now())
       AND ai_summary IS NULL AND length(coalesce(description,'')) >= 120
     ORDER BY publication_date DESC NULLS LAST LIMIT $1`, [limit]);
  let done = 0;
  let failed = 0;
  for (const t of rows) {
    try {
      const r = await generateTender(t);
      if (r) {
        await pool.query('UPDATE tenders SET ai_summary=$1, ai_points=$2, ai_at=now() WHERE id=$3',
          [r.summary, r.points, t.id]);
        done++;
      } else {
        await pool.query('UPDATE tenders SET ai_summary=$1, ai_at=now() WHERE id=$2', ['', t.id]);
      }
    } catch (e) {
      failed++;
      console.error('[ai-tender]', t.id, e.message);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { candidates: rows.length, generated: done, failed };
}

module.exports = { runAiTenders, generateTender };
