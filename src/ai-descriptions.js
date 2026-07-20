// AI generovanie „predajných" popisov výziev pre e-maily a zoznamy (Claude Haiku).
// Z overených faktov výzvy vytvorí pútavý slovenský názov + jednovetový teaser.
// PRÍSNE: používa len dodané fakty, nič si nevymýšľa (sumy, oprávnenosť, termíny).

const { pool } = require('./db');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

function factsFor(v) {
  const rok = v.deadline ? new Date(v.deadline).getFullYear()
    : v.announced ? new Date(v.announced).getFullYear() : new Date().getFullYear();
  const suma = v.amount_max ? `do ${Number(v.amount_max).toLocaleString('sk-SK')} €`
    : v.amount_min ? `od ${Number(v.amount_min).toLocaleString('sk-SK')} €`
    : v.allocation ? `alokácia ${Number(v.allocation).toLocaleString('sk-SK')} €` : 'suma neurčená';
  return [
    `Oficiálny názov: ${v.title}`,
    v.provider ? `Vyhlasovateľ: ${v.provider}` : null,
    `Oblasť: ${v.category}`,
    `Výška podpory: ${suma}`,
    v.applicants ? `Oprávnení žiadatelia: ${v.applicants}` : null,
    v.deadline ? `Uzávierka: ${new Date(v.deadline).toLocaleDateString('sk-SK')}` : (v.deadline_note || null),
    v.objectives ? `Ciele: ${String(v.objectives).replace(/\n/g, '; ').slice(0, 400)}` : null,
    v.summary ? `Zhrnutie: ${String(v.summary).slice(0, 400)}` : null,
    `Rok: ${rok}`,
  ].filter(Boolean).join('\n');
}

const SYSTEM = `Si copywriter slovenského grantového portálu. Z DODANÝCH FAKTOV o výzve vytvor:
1) "title" — pútavý, ľudsky zrozumiteľný názov v slovenčine, ideálne v štýle "Grant až do {suma} na {stručný predmet} ({rok})". Max 95 znakov. Ak suma nie je známa, formuluj názov bez sumy.
2) "teaser" — JEDNA veta (max 140 znakov), ktorá vzbudí záujem a naznačí, čo sa žiadateľ dozvie (napr. "Zistite, kto je oprávnený žiadateľ a aké náklady pokrýva.").
PRAVIDLÁ: Používaj VÝHRADNE dodané fakty. Nikdy si nevymýšľaj sumy, percentá, oprávnenosť ani termíny. Píš spisovne po slovensky. Vráť IBA čistý JSON: {"title":"...","teaser":"..."} bez ďalšieho textu.`;

async function generateOne(v) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY chýba');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Fakty o výzve:\n${factsFor(v)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const text = (data.content || [])[0] && data.content[0].text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('bez JSON');
  const out = JSON.parse(m[0]);
  const title = String(out.title || '').trim().slice(0, 120);
  const teaser = String(out.teaser || '').trim().slice(0, 180);
  if (!title) throw new Error('prázdny title');
  return { title, teaser };
}

// Dávkovo vygeneruj popisy pre výzvy, ktoré ich ešte nemajú
async function runAiDescriptions(limit = 60) {
  if (!API_KEY) return { skipped: 'no_api_key' };
  const { rows } = await pool.query(
    `SELECT * FROM vyzvy WHERE status = 'otvorena' AND ai_title IS NULL
     ORDER BY created_at DESC LIMIT $1`, [limit]);
  let done = 0;
  let failed = 0;
  for (const v of rows) {
    try {
      const { title, teaser } = await generateOne(v);
      await pool.query(
        `UPDATE vyzvy SET ai_title = $1, ai_teaser = $2, ai_generated_at = now() WHERE id = $3`,
        [title, teaser, v.id]);
      done++;
    } catch (e) {
      failed++;
      console.error('[ai]', v.slug, e.message);
    }
    await new Promise((r) => setTimeout(r, 250)); // šetrné tempo
  }
  return { candidates: rows.length, generated: done, failed };
}

module.exports = { runAiDescriptions, generateOne };
