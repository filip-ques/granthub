// Fond na podporu umenia — tabuľka výziev na fpu.sk/sk/vyzvy/ (server-rendered).
// Momentálne bývajú medzi výzvami aj zatvorené; berieme len stav „Otvorená“.

const cheerio = require('cheerio');
const { fetchHtml, slugify, parseSkDate } = require('./common');

const LIST_URL = 'https://www.fpu.sk/sk/vyzvy/';

async function scrape() {
  const html = await fetchHtml(LIST_URL);
  const $ = cheerio.load(html);
  const items = [];

  $('table.table-hover tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;

    const link = $(tds[0]).find('a.item-link').first();
    const title = link.text().trim();
    const url = link.attr('href');
    if (!title || !url) return;

    const status = $(tds[tds.length - 1]).text().trim().toLowerCase();
    if (!status.includes('otvoren')) return;

    // Okno podávania: "27.04.2026 – 25.05.2026"
    const window = $(tds[1]).text();
    const dates = window.match(/\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/g) || [];
    const from = dates[0] ? parseSkDate(dates[0]) : null;
    const to = dates[1] ? parseSkDate(dates[1]) : null;

    // Podprogramy: kód + názov + typ (Dotácia/Štipendium)
    const programs = [];
    $(tds[2]).find('.accordion-body > div > a').each((_, a) => {
      const code = $(a).find('span.mr-2').first().text().trim().replace(/[ ,]+$/, '');
      const type = $(a).find('span.badge').first().text().trim();
      const name = $(a).clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
      if (code || name) programs.push(`${code} ${name}${type ? ` (${type.toLowerCase()})` : ''}`.trim());
    });
    const progText = programs.slice(0, 6).join('; ') + (programs.length > 6 ? `; … (+${programs.length - 6})` : '');

    items.push({
      slug: slugify(new URL(url).pathname, 'fpu'),
      title: `${title} — Fond na podporu umenia`,
      provider: 'Fond na podporu umenia',
      program: 'Štruktúra podpornej činnosti FPU',
      category: 'Kultúra, cestovný ruch a šport',
      applicants: 'subjekty pôsobiace v umení a kultúre — podľa podprogramu',
      deadline: to,
      deadline_note: to ? null : 'termín podľa výzvy',
      summary: `Výzva Fondu na podporu umenia` +
        (from && to ? `, žiadosti od ${new Date(from).toLocaleDateString('sk-SK')} do ${new Date(to).toLocaleDateString('sk-SK')}` : '') +
        (progText ? `. Podprogramy: ${progText}.` : '.'),
      source_url: url,
    });
  });

  return items;
}

module.exports = { scrape };
