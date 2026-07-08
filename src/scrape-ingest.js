// Spúšťač scraperov ďalších grantových zdrojov (mimo ITMS).
// Každý scraper vráti pole položiek; upsert a uzatváranie rieši common.upsertVyzvy.

const { pool } = require('./db');
const { upsertVyzvy } = require('./scrapers/common');

const SCRAPERS = [
  { source: 'fpu', run: () => require('./scrapers/fpu').scrape() },
  { source: 'envirofond', run: () => require('./scrapers/envirofond').scrape() },
  { source: 'planobnovy', run: () => require('./scrapers/planobnovy').scrape() },
  { source: 'euportal', run: () => require('./scrapers/euportal').scrape() },
  { source: 'fnps', run: () => require('./scrapers/fnps').scrape() },
  { source: 'kultminor', run: () => require('./scrapers/kultminor').scrape() },
  { source: 'avf', run: () => require('./scrapers/avf').scrape() },
];

async function runScrapers() {
  const results = {};
  for (const s of SCRAPERS) {
    try {
      const items = await s.run();
      results[s.source] = await upsertVyzvy(s.source, items);
    } catch (e) {
      console.error(`[scrape] ${s.source} zlyhal:`, e.message);
      results[s.source] = { error: e.message };
    }
  }
  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('scrape_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [new Date().toISOString()]
  );
  return results;
}

module.exports = { runScrapers };
