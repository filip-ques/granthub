// Audit odkazov v DB: skontroluje source_url aj links JSONB všetkých otvorených
// výziev a vypíše nefunkčné (HTTP >= 400, timeout, DNS chyba).
// Spustenie: DATABASE_URL=... DATABASE_SCHEMA=granthub node scripts/check-links.js

const { pool } = require('../src/db');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function checkUrl(url) {
  // opendata API odmieta HEAD (ECONNRESET) a burst GETy limituje 503 — linky
  // generujeme sami z platných ID, netreba ich overovať
  if (url.includes('opendata.itms2014.sk')) return { ok: true, status: 200 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // HEAD najprv; niektoré servery HEAD nepodporujú → skús GET
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA } });
    if (res.status === 405 || res.status === 403 || res.status === 404) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA } });
    }
    return { ok: res.ok, status: res.status, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const { rows } = await pool.query(
    `SELECT id, slug, source, source_url, links FROM vyzvy WHERE status = 'otvorena' ORDER BY id`);

  // Zozbieraj unikátne URL s odkazmi na riadky
  const urlMap = new Map(); // url -> [{id, slug, kind, idx}]
  for (const r of rows) {
    if (r.source_url) {
      if (!urlMap.has(r.source_url)) urlMap.set(r.source_url, []);
      urlMap.get(r.source_url).push({ id: r.id, slug: r.slug, source: r.source, kind: 'source_url' });
    }
    for (const [idx, l] of (r.links || []).entries()) {
      if (!l.url) continue;
      if (!urlMap.has(l.url)) urlMap.set(l.url, []);
      urlMap.get(l.url).push({ id: r.id, slug: r.slug, source: r.source, kind: 'link', idx, nazov: l.nazov });
    }
  }

  console.log(`Kontrolujem ${urlMap.size} unikátnych URL z ${rows.length} výziev…`);
  const urls = [...urlMap.keys()];
  const results = new Map();
  const CONCURRENCY = 10;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map((u) => checkUrl(u)));
    batch.forEach((u, j) => results.set(u, out[j]));
    process.stdout.write(`\r${Math.min(i + CONCURRENCY, urls.length)}/${urls.length}`);
  }
  console.log();

  const broken = [];
  for (const [url, res] of results) {
    if (!res.ok) broken.push({ url, ...res, refs: urlMap.get(url) });
  }
  broken.sort((a, b) => String(a.refs[0].source).localeCompare(String(b.refs[0].source)));

  console.log(`\nNEFUNKČNÉ: ${broken.length} z ${urls.length}\n`);
  for (const b of broken) {
    const ref = b.refs[0];
    console.log(`[${ref.source}] ${b.status || b.error} ${b.url}`);
    for (const r of b.refs.slice(0, 3)) {
      console.log(`   ↳ ${r.slug} (${r.kind}${r.nazov ? `: ${r.nazov}` : ''})`);
    }
  }

  // strojovo čitateľný výstup pre opravný skript
  require('fs').writeFileSync('/tmp/broken-links.json', JSON.stringify(broken, null, 1));
  console.log('\nZoznam uložený do /tmp/broken-links.json');
  await pool.end();
})();
