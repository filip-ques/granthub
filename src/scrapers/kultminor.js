// Fond na podporu kultúry národnostných menšín — ročníkový zoznam výziev (Joomla).

const cheerio = require('cheerio');
const { fetchHtml, slugify, parseSkDate } = require('./common');

async function scrape() {
  const year = new Date().getFullYear();
  const html = await fetchHtml(`https://www.kultminor.sk/sk/moznosti-podpory/vyzvy/vyzvy-${year}`);
  const $ = cheerio.load(html);
  const items = [];
  const now = new Date();

  const links = [];
  $('div.item .page-header h2 a[itemprop=url]').each((_, a) => {
    links.push({ title: $(a).text().trim(), url: new globalThis.URL($(a).attr('href'), 'https://www.kultminor.sk').href });
  });

  for (const l of links.slice(0, 12)) {
    // termín skúsime z textu článku ("do DD.MM.YYYY"); keď nie je, výzvu uvedieme bez pevného termínu
    let deadline = null;
    try {
      const art = await fetchHtml(l.url);
      const text = cheerio.load(art)('div.item, article, main, body').first().text();
      const m = text.match(/(?:do|najneskôr do|termíne? do)\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/i);
      if (m) deadline = parseSkDate(m[1]);
    } catch { /* detail nedostupný */ }
    if (deadline && new Date(deadline) < now) continue;
    items.push({
      slug: slugify(new globalThis.URL(l.url).pathname, 'km'),
      title: `${l.title} — Kultminor`,
      provider: 'Fond na podporu kultúry národnostných menšín',
      program: 'Kultminor',
      category: 'Kultúra, cestovný ruch a šport',
      applicants: 'subjekty pôsobiace v kultúre národnostných menšín',
      deadline,
      deadline_note: deadline ? null : 'termín v texte výzvy',
      summary: `Výzva Fondu na podporu kultúry národnostných menšín (${l.title}).` +
        (deadline ? ` Uzávierka ${new Date(deadline).toLocaleDateString('sk-SK')}.` : '') +
        ' Podmienky a podprogramy uvádza text výzvy.',
      source_url: l.url,
    });
  }
  return items;
}

module.exports = { scrape };
