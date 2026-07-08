// Audiovizuálny fond — ročníková tabuľka výziev (starý ASP.NET, editorský obsah).
// Bunky sú neštruktúrované, dátumové okná parsujeme regexom po riadkoch.

const cheerio = require('cheerio');
const { fetchHtml, slugify, parseSkDate } = require('./common');

async function scrape() {
  const year = new Date().getFullYear();
  const html = await fetchHtml(`https://www.avf.sk/vyzvy${year}.aspx`);
  const $ = cheerio.load(html);
  const items = [];
  const now = new Date();

  // Titulok výzvy a dátumové okná bývajú v samostatných riadkoch — páruj s posledným titulkom
  let current = null;
  $('table tr').each((_, tr) => {
    const rowText = $(tr).text().replace(/\s+/g, ' ');
    const link = $(tr).find('a[href*="challenge"]').first();
    const titleMatch = rowText.match(/Výzva\s*\d+\/\d{4}/);
    if (titleMatch && !/\d{1,2}\.\d{1,2}\.\d{4}/.test(rowText)) {
      current = { title: titleMatch[0], href: link.attr('href') || null };
      return;
    }
    if (!current) return;

    const windows = [...rowText.matchAll(/(\d{1,2}\.\d{1,2}\.\d{4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{4})/g)];
    if (!windows.length) return;
    const { title, href } = current;
    current = null;
    let deadline = null;
    for (const w of windows) {
      const to = parseSkDate(w[2]);
      if (to && new Date(to) >= now) { deadline = to; break; }
    }
    if (!deadline) return; // všetky okná po termíne
    items.push({
      slug: slugify(title.replace(/\//g, '-'), 'avf'),
      title: `${title} — Audiovizuálny fond`,
      provider: 'Audiovizuálny fond',
      program: 'Audiovizuálny fond',
      category: 'Kultúra, cestovný ruch a šport',
      applicants: 'subjekty pôsobiace v audiovízii — podľa programu výzvy',
      deadline,
      summary: `Výzva Audiovizuálneho fondu (${title}). Najbližšia uzávierka ${new Date(deadline).toLocaleDateString('sk-SK')}. Programy a podmienky uvádza text výzvy.`,
      source_url: href ? new globalThis.URL(href, 'https://www.avf.sk').href : `https://www.avf.sk/vyzvy${year}.aspx`,
    });
  });
  return items;
}

module.exports = { scrape };
