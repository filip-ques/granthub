// AI obohatenie výziev o štruktúrovaný rozpis (Claude Haiku/Sonnet).
// Stiahne plný oficiálny text výzvy zo zdroja a vytvorí z neho slovenský
// štruktúrovaný prehľad (vlastnými slovami — nie doslovná kópia):
//   { summary, oblasti, ziadatelia, aktivity, naklady, hodnotenie, poznamka }
// Ukladá do vyzvy.ai_details (JSONB). Používa VÝHRADNE fakty zo zdroja.

const cheerio = require('cheerio');
const { pool } = require('./db');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_DETAILS_MODEL || 'claude-haiku-4-5-20251001';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) GrantHub/1.0 (+https://granthub.sk)';

// EÚ Funding & Tenders — plný text témy podľa identifikátora (SEDIA search-api).
// Kľúčové: query a languages musia ísť ako blob parts s type application/json.
async function fetchEuTopic(identifier) {
  const q = JSON.stringify({ bool: { must: [{ terms: { type: ['1'] } }, { terms: { identifier: [identifier] } }] } });
  const fd = new FormData();
  fd.append('query', new Blob([q], { type: 'application/json' }), 'blob');
  fd.append('languages', new Blob(['["en"]'], { type: 'application/json' }), 'blob');
  const res = await fetch('https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***&pageSize=1&pageNumber=1', {
    method: 'POST', headers: { 'user-agent': UA }, body: fd,
  });
  if (!res.ok) throw new Error(`SEDIA ${res.status}`);
  const data = await res.json();
  const hit = (data.results || [])[0];
  if (!hit || !hit.metadata) return '';
  const md = hit.metadata;
  const grab = (v) => (Array.isArray(v) ? v.filter(Boolean).join('\n') : (v || ''));
  const parts = [];
  for (const k of ['title', 'callTitle', 'descriptionByte', 'destinationDescription', 'topicConditions', 'supportInfo']) {
    const t = grab(md[k]);
    if (t) parts.push(t);
  }
  return htmlToText(parts.join('\n\n'));
}

function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`);
  $('script,style,nav,footer,header').remove();
  return $.text().replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Stiahne oficiálny text zo source_url (HTML stránka vyhlasovateľa)
async function fetchSourceText(url) {
  if (!url || !/^https?:\/\//.test(url)) return '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return '';
    return htmlToText(await res.text()).slice(0, 12000);
  } catch { return ''; }
}

// Plán obnovy — detail z verejného ISPO API (oprávnení žiadatelia, cieľ, podmienky)
async function fetchIspoDetail(vyzvaId) {
  const res = await fetch(`https://public-api.planobnovy.sk/public/vyzva/${vyzvaId}`,
    { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) return '';
  const d = await res.json();
  const parts = [
    d.nazov, d.ciel, d.opravneniZiadatelia, d.uzavretieText,
    d.mieraSpolufinancovania ? `Miera spolufinancovania: ${d.mieraSpolufinancovania}` : '',
    d.oblast, d.komponent, d.opatrenie,
  ].filter(Boolean).join('\n\n');
  return htmlToText(parts);
}

// Zdrojový text pre výzvu podľa jej pôvodu
async function fullTextFor(v) {
  if (v.source === 'euportal' && v.source_url) {
    // identifikátor je v source_url: .../topic-details/SOCPL-2026-SOC-DIALOG
    const m = decodeURIComponent(v.source_url).match(/topic-details\/([A-Za-z0-9._-]+)/);
    if (m) {
      try { const t = await fetchEuTopic(m[1]); if (t && t.length > 200) return t; } catch { /* fallback nižšie */ }
    }
  }
  if (v.source === 'planobnovy' && v.source_url) {
    const m = v.source_url.match(/vyzvy\/(\d+)/);
    if (m) { try { const t = await fetchIspoDetail(m[1]); if (t && t.length > 150) return t; } catch { /* fallback */ } }
  }
  // stránka vyhlasovateľa (envirofond, avf, kultminor, fpu, manual)
  const web = await fetchSourceText(v.source_url);
  if (web && web.length > 400) return web;
  // posledná záchrana: reálne oficiálne fakty, ktoré už máme (ITMS ciele a pod.)
  const own = [v.objectives, v.summary, v.details].filter(Boolean).join('\n\n').trim();
  return own.length > 200 ? own : (web || '');
}

const SYSTEM = `Si odborný editor slovenského grantového portálu. Z DODANÉHO OFICIÁLNEHO TEXTU výzvy vytvor štruktúrovaný, vecný prehľad v spisovnej slovenčine, VLASTNÝMI SLOVAMI (nie doslovný preklad ani kópia). Zhrň a preformuluj obsah.
Vráť IBA čistý JSON s týmito kľúčmi (každý je text alebo pole textov; ak informácia v zdroji nie je, daj prázdny reťazec ""):
{
 "summary": "2-4 vety o tom, o čo vo výzve ide a čo financuje",
 "oblasti": "podporované oblasti / ciele — 3-6 viet alebo odrážok oddelených znakom |",
 "ziadatelia": "kto je oprávnený žiadateľ — odrážky oddelené |",
 "aktivity": "oprávnené aktivity / náklady — odrážky oddelené |",
 "hodnotenie": "ako sa hodnotí a vyberá (ak je uvedené) — 1-3 vety",
 "poznamka": "dôležité upozornenia (termíny, kde podať, dvojité financovanie) — 1-2 vety"
}
PRAVIDLÁ: Používaj VÝHRADNE informácie z dodaného textu. Nič si nevymýšľaj. Ak je text v angličtine, obsah presne prelož a zhrň po slovensky. Vráť len JSON.`;

async function generateDetails(v, fullText) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY chýba');
  if (!fullText || fullText.length < 200) return null; // málo podkladu → nerobíme
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Oficiálny text výzvy „${v.title}“:\n\n${fullText.slice(0, 14000)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const text = (data.content || [])[0] && data.content[0].text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const out = JSON.parse(m[0]);
  // aspoň summary musí byť
  if (!out.summary || String(out.summary).trim().length < 20) return null;
  return out;
}

async function runAiDetails(limit = 25) {
  if (!API_KEY) return { skipped: 'no_api_key' };
  // prioritne výzvy s oficiálnym odkazom a bez rozpisu
  const { rows } = await pool.query(
    `SELECT * FROM vyzvy WHERE status = 'otvorena' AND ai_details IS NULL AND source_url IS NOT NULL
     ORDER BY (source = 'euportal') DESC, created_at DESC LIMIT $1`, [limit]);
  let done = 0;
  let empty = 0;
  let failed = 0;
  for (const v of rows) {
    try {
      const text = await fullTextFor(v);
      const details = await generateDetails(v, text);
      if (details) {
        await pool.query('UPDATE vyzvy SET ai_details = $1, ai_details_at = now() WHERE id = $2',
          [JSON.stringify(details), v.id]);
        done++;
      } else {
        // označ, že sme skúsili, nech to necyklí donekonečna (prázdny objekt)
        await pool.query('UPDATE vyzvy SET ai_details = $1, ai_details_at = now() WHERE id = $2',
          [JSON.stringify({}), v.id]);
        empty++;
      }
    } catch (e) {
      failed++;
      console.error('[ai-details]', v.slug, e.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { candidates: rows.length, generated: done, empty, failed };
}

module.exports = { runAiDetails, generateDetails, fullTextFor };
