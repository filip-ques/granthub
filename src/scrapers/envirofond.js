// Environmentálny fond — zoznam aktuálnych výziev a špecifikácií.
// Zdroj: WP REST API stránky „Aktuálne výzvy a špecifikácie“ (server-rendered tabuľka).

const cheerio = require('cheerio');
const { fetchJson, slugify, parseSkDate } = require('./common');

const LIST_API = 'https://envirofond.sk/wp-json/wp/v2/pages/16560?_fields=content,modified';

async function scrape() {
  const page = await fetchJson(LIST_API);
  const $ = cheerio.load(page.content.rendered);
  const items = [];

  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;
    const link = $(tds[0]).find('a').first();
    const title = link.text().trim();
    const url = link.attr('href');
    if (!title || !url) return;

    const status = $(tds[3]).text().trim().toLowerCase();
    if (!status.includes('otvoren')) return;

    // Pri predĺžení uzávierky je nový dátum mimo <del>, starý v <del>
    const toCell = $(tds[2]).clone();
    toCell.find('del').remove();
    const from = parseSkDate($(tds[1]).text());
    const to = parseSkDate(toCell.text());

    const isMof = /mof|moderniza/i.test(title) || /modernizacny-fond/.test(url);
    items.push({
      slug: slugify(new URL(url).pathname, 'ef'),
      title,
      provider: 'Environmentálny fond',
      program: isMof ? 'Modernizačný fond' : 'Dotácie Environmentálneho fondu',
      category: 'Ochrana životného prostredia',
      applicants: 'podľa špecifikácie výzvy',
      deadline: to,
      deadline_note: to ? null : 'termín v špecifikácii výzvy',
      summary: `Výzva Environmentálneho fondu.` +
        (from ? ` Žiadosti sa podávajú od ${new Date(from).toLocaleDateString('sk-SK')}` : '') +
        (to ? `${from ? ' do' : ' Uzávierka'} ${new Date(to).toLocaleDateString('sk-SK')}.` : '') +
        ' Podrobné podmienky, oprávnených žiadateľov a alokáciu uvádza špecifikácia na stránke fondu.',
      source_url: url,
    });
  });

  return items;
}

module.exports = { scrape };
