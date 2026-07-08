// Plán obnovy a odolnosti SR — verejné JSON API systému ISPO.
// Zoznam zverejnených výziev + detail (alokácia, vyhlasovateľ, oprávnení žiadatelia).

const cheerio = require('cheerio');
const { fetchJson, slugify } = require('./common');

const API = 'https://public-api.planobnovy.sk';

// Zaradenie do oblasti podľa oblasti/komponentu Plánu obnovy
const AREA_CATEGORY = [
  { re: /doprav/i, cat: 'Doprava a cyklodoprava' },
  { re: /energ|obnoviteľn|budov|dekarboniz/i, cat: 'Energetika a OZE' },
  { re: /digit|informatiz/i, cat: 'Digitalizácia a IT' },
  { re: /vzdel|škol/i, cat: 'Vzdelávanie' },
  { re: /zdrav/i, cat: 'Sociálne služby a zdravotníctvo' },
  { re: /veda|výskum|inováci/i, cat: 'Veda a výskum' },
  { re: /klím|klimat|adaptáci|krajin|životn/i, cat: 'Ochrana životného prostredia' },
];

function pickCategory(...texts) {
  const t = texts.filter(Boolean).join(' ');
  const hit = AREA_CATEGORY.find((m) => m.re.test(t));
  return hit ? hit.cat : 'Eurofondy';
}

function stripHtml(html) {
  if (!html) return '';
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

async function scrape() {
  const items = [];
  let page = 0;
  let totalPages = 1;
  const open = [];

  while (page < totalPages && page < 10) {
    const data = await fetchJson(
      `${API}/public/vyzva?page=${page}&size=100&rsql=stav==ZVEREJNENA&sortBy=datumVyhlasenia&direction=DESC`);
    totalPages = data.totalPages || 1;
    open.push(...(data.content || []));
    page++;
  }

  const now = new Date();
  for (const v of open) {
    // niektoré ZVEREJNENA majú už minulú uzávierku — preskoč
    if (v.datumCasUzavretia && new Date(v.datumCasUzavretia) < now) continue;

    let detail = null;
    try {
      detail = await fetchJson(`${API}/public/vyzva/${v.vyzvaId}`);
    } catch { /* zoznamové polia stačia */ }
    const d = detail || v;

    const allocation = Number(d.vyskaFinancnychProstriedkov ?? d.sumVyskaProstriedkov) || null;
    const applicantsRaw = stripHtml(d.opravneniZiadatelia);
    const applicants = applicantsRaw
      ? (applicantsRaw.length > 180 ? applicantsRaw.slice(0, 177) + '…' : applicantsRaw)
      : 'podľa dokumentácie výzvy';
    const deadline = v.datumCasUzavretia ? String(v.datumCasUzavretia).slice(0, 10) : null;

    items.push({
      slug: slugify(v.kod || v.vyzvaId, 'po'),
      title: v.nazov,
      provider: d.vyhlasovatel || v.vykonavatel || 'Plán obnovy a odolnosti SR',
      program: `Plán obnovy a odolnosti${v.komponent ? ` — ${v.komponent}` : ''}`,
      category: pickCategory(v.oblast, v.komponent, v.nazov),
      applicants,
      allocation,
      deadline,
      deadline_note: deadline
        ? (d.uzavretieText && /vyčerpan/i.test(d.uzavretieText) ? 'alebo do vyčerpania alokácie' : null)
        : 'do vyčerpania alokácie / podľa výzvy',
      summary: `Výzva ${v.kod} z Plánu obnovy a odolnosti SR` +
        (v.komponent ? `, komponent ${v.komponent}` : '') +
        (allocation ? `, alokácia ${allocation.toLocaleString('sk-SK')} €` : '') +
        '. Podrobné podmienky nájdete v úplnom znení výzvy v systéme ISPO.',
      source_url: `https://ispo.planobnovy.sk/app/vyzvy/${v.vyzvaId}`,
    });
  }

  return items;
}

module.exports = { scrape };
