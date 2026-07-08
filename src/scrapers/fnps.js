// Fond na podporu športu — teasery výziev (Drupal, server-rendered, strojové dátumy).

const cheerio = require('cheerio');
const { fetchHtml, slugify } = require('./common');

const LISTS = [
  'https://www.fnps.sk/moznosti-podpory/sportova-infrastruktura',
  'https://www.fnps.sk/moznosti-podpory/vyznamne-sutaze',
];

async function scrape() {
  const items = [];
  const now = new Date();

  for (const list of LISTS) {
    let html;
    try { html = await fetchHtml(list); } catch { continue; }
    const $ = cheerio.load(html);
    $('article.node--type-vyzva').each((_, el) => {
      const title = $(el).find('h4.node-title span').first().text().trim();
      if (!title) return;
      const times = $(el).find('.field--name-field-date-range time');
      const from = times.eq(0).attr('datetime') || null;
      const to = times.eq(1).attr('datetime') || null;
      if (!to || new Date(to) < now) return; // len prebiehajúce
      const href = $(el).find('a').first().attr('href');
      items.push({
        slug: slugify(title, 'fnps'),
        title,
        provider: 'Fond na podporu športu',
        program: 'Fond na podporu športu',
        category: 'Kultúra, cestovný ruch a šport',
        applicants: 'podľa podmienok výzvy (obce, športové organizácie)',
        deadline: to.slice(0, 10),
        summary: `Výzva Fondu na podporu športu` +
          (from ? `, žiadosti od ${new Date(from).toLocaleDateString('sk-SK')}` : '') +
          ` do ${new Date(to).toLocaleDateString('sk-SK')}. Podmienky a alokáciu uvádza text výzvy.`,
        source_url: href ? new globalThis.URL(href, 'https://www.fnps.sk').href : list,
      });
    });
  }
  return items;
}

module.exports = { scrape };
