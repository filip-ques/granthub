// EÚ Funding & Tenders — oficiálny statický JSON so všetkými témami (grantsTenders.json).
// Súbor má ~125 MB, preto sa spracúva streamovaním. Berieme len otvorené granty (type=1).

const { Readable } = require('stream');
const { parser } = require('stream-json');
const { pick } = require('stream-json/filters/Pick');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { slugify } = require('./common');

const URL = 'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/grantsTenders.json';

const PROGRAMME_CATEGORY = [
  [/^HORIZON/, 'Veda a výskum'],
  [/^ERASMUS/, 'Vzdelávanie'],
  [/^LIFE/, 'Ochrana životného prostredia'],
  [/^DIGITAL/, 'Digitalizácia a IT'],
  [/^CREA/, 'Kultúra, cestovný ruch a šport'],
  [/^EU4H|^HEALTH/, 'Sociálne služby a zdravotníctvo'],
  [/^CEF/, 'Doprava a cyklodoprava'],
  [/^SMP|^COSME/, 'Rozvoj podnikania'],
];

async function scrape() {
  const res = await fetch(URL, { headers: { 'user-agent': 'GrantHub/1.0 (+https://granthub.sk)' } });
  if (!res.ok) throw new Error(`EU portal ${res.status}`);

  const items = [];
  const now = Date.now();

  await new Promise((resolve, reject) => {
    const pipeline = Readable.fromWeb(res.body)
      .pipe(parser())
      .pipe(pick({ filter: 'fundingData.GrantTenderObj' }))
      .pipe(streamArray());

    pipeline.on('data', ({ value: t }) => {
      try {
        if (t.type !== 1) return; // len granty, nie tendre
        if (!t.status || t.status.abbreviation !== 'Open') return;
        const prog = (t.frameworkProgramme && t.frameworkProgramme.abbreviation) || 'EÚ program';
        // najbližšia budúca uzávierka
        const future = (t.deadlineDatesLong || []).filter((d) => d > now).sort((a, b) => a - b);
        const deadline = future.length ? new Date(future[0]).toISOString().slice(0, 10) : null;
        const cat = PROGRAMME_CATEGORY.find(([re]) => re.test(prog));
        items.push({
          slug: slugify(t.identifier, 'eu'),
          title: t.title || t.identifier,
          provider: 'Európska komisia',
          program: `${prog}${t.callIdentifier ? ` — ${t.callIdentifier}` : ''}`,
          category: cat ? cat[1] : 'Eurofondy',
          applicants: 'podľa podmienok témy — programy EÚ sú otvorené aj slovenským žiadateľom',
          deadline,
          deadline_note: deadline ? null : 'termín podľa témy',
          summary: `Otvorená téma ${t.identifier} programu ${prog}` +
            (t.callTitle ? ` (výzva: ${t.callTitle})` : '') +
            '. Úplné podmienky sú na EÚ portáli Funding & Tenders.',
          source_url: `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${encodeURIComponent(t.identifier)}`,
        });
      } catch { /* preskoč vadný záznam */ }
    });
    pipeline.on('end', resolve);
    pipeline.on('error', reject);
  });

  return items;
}

module.exports = { scrape };
