const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, init } = require('./src/db');
const { sendMail } = require('./src/mailer');
const auth = require('./src/auth');
const { runIngest } = require('./src/ingest');
const { runRadar, unsubToken } = require('./src/radarjob');
const admin = require('./src/admin');
const { runTenderIngest } = require('./src/tender-ingest');
const { runScrapers } = require('./src/scrape-ingest');
const tcat = require('./src/tender-catalog');
const { CATEGORIES, APPLICANTS, REGIONS, SEGMENTS, SERVICES } = require('./src/data');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Bezpečnostné hlavičky ---
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

// --- CSRF ochrana: POSTy len z vlastného originu (dopĺňa sameSite=lax cookie) ---
app.use((req, res, next) => {
  if (req.method === 'POST' && !req.path.startsWith('/cron/')) {
    const origin = req.get('origin') || '';
    const host = req.get('host') || '';
    if (origin && new URL(origin).host !== host) {
      return res.status(403).send('Cross-origin request blocked');
    }
  }
  next();
});

// --- Rate limit citlivých POST endpointov (in-memory, per IP) ---
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || [];
    const fresh = bucket.filter((t) => now - t < windowMs);
    if (fresh.length >= max) return res.status(429).send('Priveľa požiadaviek, skúste o chvíľu.');
    fresh.push(now);
    rateBuckets.set(key, fresh);
    if (rateBuckets.size > 10000) rateBuckets.clear(); // poistka proti rastu pamäte
    next();
  };
}
app.use(['/prihlasenie', '/registracia'], (req, res, next) =>
  req.method === 'POST' ? rateLimit(5, 15 * 60 * 1000)(req, res, next) : next());
app.use(['/grantovy-radar', '/objednavka', '/kontakt'], (req, res, next) =>
  req.method === 'POST' ? rateLimit(10, 15 * 60 * 1000)(req, res, next) : next());

app.use(express.urlencoded({ extended: true, limit: '50kb', parameterLimit: 100 }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-secret-zmen-v-produkcii',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 },
  })
);

app.use(auth.loadUser);
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.CATEGORIES = CATEGORIES;
  res.locals.APPLICANTS = APPLICANTS;
  res.locals.REGIONS = REGIONS;
  res.locals.SERVICES = SERVICES;
  res.locals.INDUSTRIES = tcat.INDUSTRIES;
  res.locals.TENDER_REGIONS = tcat.TENDER_REGIONS;
  next();
});
app.use((req, res, next) => { res.locals.isAdmin = admin.isAdmin(res.locals.user); next(); });

// --- Audit log: každá požiadavka (bez statiky) do activity_events ---
app.use((req, res, next) => {
  if (/^\/(css|js|img|idsk|assets|favicon)/.test(req.path)) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    pool.query(
      `INSERT INTO activity_events (user_id, method, path, status, ip, user_agent, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.session?.userId || null, req.method, req.path.slice(0, 300), res.statusCode,
       String(req.ip || '').slice(0, 60), String(req.get('user-agent') || '').slice(0, 300),
       Date.now() - t0]
    ).catch(() => {});
  });
  next();
});
app.use(auth.router);
app.use(admin.router);

const fmtEur = (n) =>
  n == null ? null : Number(n).toLocaleString('sk-SK', { maximumFractionDigits: 0 }) + ' €';
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' }) : null;
const daysLeft = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86400000) : null);
app.locals.cpvLabel = tcat.cpvLabel;
app.locals.noticeLabel = tcat.noticeLabel;
app.locals.industryLabel = (k) => tcat.INDUSTRY_LABELS[k] || k;

const fmtDays = (n) => {
  if (n === 0) return 'posledný deň';
  if (n === 1) return 'zostáva 1 deň';
  if (n >= 2 && n <= 4) return `zostávajú ${n} dni`;
  return `zostáva ${n} dní`;
};
app.locals.fmtEur = fmtEur;
app.locals.fmtDate = fmtDate;
app.locals.daysLeft = daysLeft;
app.locals.fmtDays = fmtDays;

// ---------- Titulka ----------
app.get('/', async (req, res) => {
  const [{ rows: vyzvy }, { rows: [{ count }] }, { rows: tendre }, { rows: [{ tcount }] }] = await Promise.all([
    pool.query(
      `SELECT * FROM vyzvy WHERE status = 'otvorena' AND (deadline IS NULL OR deadline >= now()::date)
       ORDER BY deadline ASC NULLS LAST LIMIT 4`),
    pool.query(
      `SELECT count(*)::int AS count FROM vyzvy WHERE status = 'otvorena' AND (deadline IS NULL OR deadline >= now()::date)`),
    pool.query(
      `SELECT * FROM tenders WHERE deadline IS NULL OR deadline >= now()
       ORDER BY publication_date DESC NULLS LAST LIMIT 4`),
    pool.query(`SELECT count(*)::int AS tcount FROM tenders WHERE deadline IS NULL OR deadline >= now()`),
  ]);
  res.render('index', { title: null, vyzvy, openCount: count, tendre, tenderCount: tcount });
});

// ---------- Katalóg výziev ----------
app.get('/vyzvy', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const kategoria = String(req.query.kategoria || '');
  const ziadatel = String(req.query.ziadatel || '');
  const kraj = String(req.query.kraj || '');
  const stav = String(req.query.stav || 'otvorena');

  const conds = [];
  const params = [];
  const add = (sqlTemplate, value) => {
    params.push(value);
    conds.push(sqlTemplate.replaceAll('?', `$${params.length}`));
  };

  if (stav === 'otvorena') conds.push(`(status = 'otvorena' AND (deadline IS NULL OR deadline >= now()::date))`);
  else if (stav === 'uzavreta') conds.push(`(status = 'uzavreta' OR (deadline IS NOT NULL AND deadline < now()::date))`);
  if (q) add(`(title ILIKE ? OR summary ILIKE ? OR coalesce(provider, '') ILIKE ?)`, `%${q}%`);
  if (kategoria) add(`category = ?`, kategoria);
  if (ziadatel) add(`applicants ILIKE ?`, `%${ziadatel}%`);
  if (kraj) add(`(regions ILIKE ? OR regions ILIKE '%Celé Slovensko%')`, `%${kraj}%`);

  let sql = `SELECT * FROM vyzvy`;
  if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
  sql += ` ORDER BY deadline ASC NULLS LAST`;

  const { rows: vyzvy } = await pool.query(sql, params);

  let savedIds = new Set();
  if (res.locals.user) {
    const { rows } = await pool.query('SELECT vyzva_id FROM saved_vyzvy WHERE user_id = $1', [res.locals.user.id]);
    savedIds = new Set(rows.map((r) => r.vyzva_id));
  }
  res.render('vyzvy', {
    title: 'Grantové výzvy',
    vyzvy, savedIds,
    filters: { q, kategoria, ziadatel, kraj, stav },
  });
});

app.get('/vyzvy/:slug', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM vyzvy WHERE slug = $1', [req.params.slug]);
  if (!rows.length) return notFound(req, res);
  const vyzva = rows[0];
  const { rows: similar } = await pool.query(
    `SELECT * FROM vyzvy WHERE category = $1 AND id <> $2 AND status = 'otvorena'
       AND (deadline IS NULL OR deadline >= now()::date)
     ORDER BY deadline ASC NULLS LAST LIMIT 3`,
    [vyzva.category, vyzva.id]
  );
  let saved = false;
  if (res.locals.user) {
    const { rows: s } = await pool.query(
      'SELECT 1 FROM saved_vyzvy WHERE user_id = $1 AND vyzva_id = $2',
      [res.locals.user.id, vyzva.id]
    );
    saved = s.length > 0;
  }
  res.render('vyzva', { title: vyzva.title, vyzva, similar, saved });
});

app.post('/vyzvy/:id/ulozit', auth.requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  if (req.body.akcia === 'odobrat') {
    await pool.query('DELETE FROM saved_vyzvy WHERE user_id = $1 AND vyzva_id = $2', [req.session.userId, id]);
  } else {
    await pool.query(
      'INSERT INTO saved_vyzvy (user_id, vyzva_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.session.userId, id]
    );
  }
  res.redirect(req.get('referer') || '/vyzvy');
});

// ---------- Tendre (verejné zákazky) ----------
app.get('/tendre', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const odvetvie = String(req.query.odvetvie || '');
  const kraj = String(req.query.kraj || '');
  const cpv = String(req.query.cpv || '').replace(/[^0-9]/g, '');
  const minHodnota = Number(req.query.min_hodnota) || null;
  const stav = String(req.query.stav || 'otvorene');
  const sort = String(req.query.sort || 'najnovsie');
  const page = Math.max(1, Number(req.query.strana) || 1);
  const PER_PAGE = 20;

  const conds = [];
  const params = [];
  const add = (tpl, val) => { params.push(val); conds.push(tpl.replaceAll('?', `$${params.length}`)); };

  if (stav === 'otvorene') conds.push(`(deadline IS NULL OR deadline >= now())`);
  else if (stav === 'uzavrete') conds.push(`deadline < now()`);
  if (q) add(`search_blob LIKE ?`, `%${tcat.foldText(q)}%`);
  if (odvetvie) add(`industry = ?`, odvetvie);
  if (kraj) add(`region_code = ?`, kraj);
  if (cpv) add(`(main_cpv LIKE ? OR cpv_codes::text LIKE ?)`.replace('?', `$${params.length + 1}`).replace('?', `$${params.length + 2}`), null), params.pop();
  if (cpv) { params.push(`${cpv}%`); params.push(`%"${cpv}%`); conds.push(`(main_cpv LIKE $${params.length - 1} OR cpv_codes::text LIKE $${params.length})`); }
  if (minHodnota) add(`value_eur >= ?`, minHodnota);

  const where = conds.length ? ` WHERE ` + conds.join(' AND ') : '';
  const order = sort === 'hodnota' ? `value_eur DESC NULLS LAST`
    : sort === 'uzavierka' ? `deadline ASC NULLS LAST`
    : `publication_date DESC NULLS LAST, id DESC`;

  const [{ rows: tendre }, { rows: [{ count }] }] = await Promise.all([
    pool.query(`SELECT * FROM tenders${where} ORDER BY ${order} LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`, params),
    pool.query(`SELECT count(*)::int AS count FROM tenders${where}`, params),
  ]);

  res.render('tendre', {
    title: 'Verejné zákazky',
    tendre, total: count, page, pages: Math.max(1, Math.ceil(count / PER_PAGE)),
    filters: { q, odvetvie, kraj, cpv, min_hodnota: req.query.min_hodnota || '', stav, sort },
  });
});

app.get('/tendre/:id', async (req, res, next) => {
  const id = Number(req.params.id) || 0;
  const { rows } = await pool.query('SELECT * FROM tenders WHERE id = $1', [id]);
  if (!rows.length) return next();
  const tender = rows[0];
  const { rows: similar } = await pool.query(
    `SELECT * FROM tenders WHERE industry = $1 AND id <> $2 AND (deadline IS NULL OR deadline >= now())
     ORDER BY publication_date DESC NULLS LAST LIMIT 3`,
    [tender.industry, tender.id]
  );
  let saved = false;
  if (res.locals.user) {
    const { rows: sv } = await pool.query(
      'SELECT 1 FROM saved_tendre WHERE user_id = $1 AND tender_id = $2', [res.locals.user.id, tender.id]);
    saved = sv.length > 0;
  }
  res.render('tender', { title: tender.title, tender, similar, saved });
});

app.post('/tendre/:id/ulozit', auth.requireLogin, async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (req.body.akcia === 'odobrat') {
    await pool.query('DELETE FROM saved_tendre WHERE user_id = $1 AND tender_id = $2', [req.session.userId, id]);
  } else {
    await pool.query(
      'INSERT INTO saved_tendre (user_id, tender_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.session.userId, id]);
  }
  res.redirect(req.get('referer') || `/tendre/${id}`);
});

// ---------- Strážcovia (uložené hľadania tendrov) ----------
app.post('/straznici', auth.requireLogin, async (req, res) => {
  const name = String(req.body.name || '').trim() || 'Moje hľadanie';
  await pool.query(
    `INSERT INTO tender_searches (user_id, name, q, industry, region_code, cpv, min_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.session.userId, name, String(req.body.q || ''), String(req.body.odvetvie || ''),
     String(req.body.kraj || ''), String(req.body.cpv || '').replace(/[^0-9]/g, ''),
     Number(req.body.min_hodnota) || null]
  );
  res.redirect('/ucet/straznici');
});

app.get('/ucet/straznici', auth.requireLogin, async (req, res) => {
  const { rows: searches } = await pool.query(
    'SELECT * FROM tender_searches WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
  res.render('zona/straznici', { title: 'Strážcovia', searches });
});

app.post('/ucet/straznici/:id/zmazat', auth.requireLogin, async (req, res) => {
  await pool.query('DELETE FROM tender_searches WHERE id = $1 AND user_id = $2',
    [Number(req.params.id) || 0, req.session.userId]);
  res.redirect('/ucet/straznici');
});

app.post('/ucet/straznici/:id/notify', auth.requireLogin, async (req, res) => {
  await pool.query('UPDATE tender_searches SET notify = NOT notify WHERE id = $1 AND user_id = $2',
    [Number(req.params.id) || 0, req.session.userId]);
  res.redirect('/ucet/straznici');
});

// ---------- Pipeline rozpracovaných tendrov ----------
const STAGES = [
  { key: 'watch', label: 'Sledujem' },
  { key: 'preparing', label: 'Pripravujem ponuku' },
  { key: 'submitted', label: 'Podané' },
  { key: 'won', label: 'Vyhraté' },
  { key: 'lost', label: 'Prehraté' },
];

app.get('/ucet/pipeline', auth.requireLogin, async (req, res) => {
  const { rows: items } = await pool.query(
    `SELECT s.stage, s.note, s.saved_at, t.* FROM saved_tendre s
     JOIN tenders t ON t.id = s.tender_id
     WHERE s.user_id = $1 ORDER BY s.saved_at DESC`, [req.session.userId]);
  res.render('zona/pipeline', { title: 'Moje tendre', items, STAGES });
});

app.post('/ucet/pipeline/:tenderId', auth.requireLogin, async (req, res) => {
  const stage = STAGES.some((st) => st.key === req.body.stage) ? req.body.stage : 'watch';
  await pool.query(
    'UPDATE saved_tendre SET stage = $1, note = $2 WHERE user_id = $3 AND tender_id = $4',
    [stage, String(req.body.note || '').trim() || null, req.session.userId, Number(req.params.tenderId) || 0]);
  res.redirect('/ucet/pipeline');
});

// ---------- Produkty firmy + párovanie na tendre ----------
app.get('/ucet/produkty', auth.requireLogin, async (req, res) => {
  const { rows: products } = await pool.query(
    'SELECT * FROM products WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
  res.render('zona/produkty', { title: 'Produkty', products });
});

app.post('/ucet/produkty', auth.requireLogin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name) {
    await pool.query(
      `INSERT INTO products (user_id, name, keywords, cpv_prefixes) VALUES ($1, $2, $3, $4)`,
      [req.session.userId, name,
       String(req.body.keywords || '').trim(),
       String(req.body.cpv_prefixes || '').replace(/[^0-9,\s]/g, '').trim()]);
  }
  res.redirect('/ucet/produkty');
});

app.post('/ucet/produkty/:id/zmazat', auth.requireLogin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1 AND user_id = $2',
    [Number(req.params.id) || 0, req.session.userId]);
  res.redirect('/ucet/produkty');
});

app.get('/ucet/produkty/:id/zhody', auth.requireLogin, async (req, res, next) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1 AND user_id = $2',
    [Number(req.params.id) || 0, req.session.userId]);
  if (!rows.length) return next();
  const product = rows[0];
  const conds = [`(deadline IS NULL OR deadline >= now())`];
  const params = [];
  const parts = [];
  for (const kw of product.keywords.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 10)) {
    params.push(`%${tcat.foldText(kw)}%`);
    parts.push(`search_blob LIKE $${params.length}`);
  }
  for (const pref of product.cpv_prefixes.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 10)) {
    params.push(`${pref}%`);
    parts.push(`main_cpv LIKE $${params.length}`);
  }
  if (parts.length) conds.push(`(${parts.join(' OR ')})`);
  const { rows: matches } = await pool.query(
    `SELECT * FROM tenders WHERE ${conds.join(' AND ')}
     ORDER BY publication_date DESC NULLS LAST LIMIT 30`, params);
  res.render('zona/zhody', { title: `Zhody — ${product.name}`, product, matches: parts.length ? matches : [] });
});

// ---------- Kalkulačka de minimis ----------
const DM_LIMIT = 300000;        // nariadenie (EÚ) 2023/2831, jediný podnik / 3 kĺzavé roky
const DM_LIMIT_DOPRAVA = 100000; // cestná nákladná doprava (do 31.12.2023, po novom tiež 300k okrem výnimiek)

app.get('/ucet/deminimis', auth.requireLogin, async (req, res) => {
  const { rows: aids } = await pool.query(
    'SELECT * FROM deminimis_aids WHERE user_id = $1 ORDER BY granted_at DESC', [req.session.userId]);
  // kĺzavé 3-ročné okno ku dnešku (nariadenie 2023/2831: 3 roky spätne od poskytnutia)
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 3);
  const inWindow = aids.filter((a) => new Date(a.granted_at) >= cutoff);
  const drawn = inWindow.reduce((s2, a) => s2 + Number(a.amount_eur), 0);
  res.render('zona/deminimis', {
    title: 'De minimis kalkulačka',
    aids, inWindow, drawn,
    remaining: Math.max(0, DM_LIMIT - drawn),
    limit: DM_LIMIT, cutoff,
    savedMsg: req.query.ok === '1',
  });
});

app.post('/ucet/deminimis', auth.requireLogin, async (req, res) => {
  const amount = Number(String(req.body.amount_eur || '').replace(',', '.'));
  const granted = String(req.body.granted_at || '');
  if (Number.isFinite(amount) && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(granted)) {
    await pool.query(
      `INSERT INTO deminimis_aids (user_id, ico, provider, scheme_code, note, amount_eur, granted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.session.userId, String(req.body.ico || '').replace(/\D/g, '').slice(0, 12),
       String(req.body.provider || '').trim().slice(0, 200),
       String(req.body.scheme_code || '').trim().slice(0, 60),
       String(req.body.note || '').trim().slice(0, 300) || null, amount, granted]);
  }
  res.redirect('/ucet/deminimis?ok=1');
});

app.post('/ucet/deminimis/:id/zmazat', auth.requireLogin, async (req, res) => {
  await pool.query('DELETE FROM deminimis_aids WHERE id = $1 AND user_id = $2',
    [Number(req.params.id) || 0, req.session.userId]);
  res.redirect('/ucet/deminimis');
});

// ---------- Zdroje dát (po prihlásení) ----------
const SOURCE_INFO = [
  { key: 'itms', name: 'ITMS / Program Slovensko', desc: 'Eurofondy — oficiálne open data API (opendata.itms2014.sk)', url: 'https://opendata.itms2014.sk' },
  { key: 'ted', name: 'TED — verejné zákazky', desc: 'Európsky vestník verejného obstarávania (oficiálne API)', url: 'https://ted.europa.eu' },
  { key: 'planobnovy', name: 'Plán obnovy (ISPO)', desc: 'Verejné API systému ISPO', url: 'https://ispo.planobnovy.sk' },
  { key: 'envirofond', name: 'Environmentálny fond', desc: 'Aktuálne výzvy a špecifikácie vrátane Modernizačného fondu', url: 'https://envirofond.sk' },
  { key: 'euportal', name: 'EÚ Funding & Tenders', desc: 'Horizon Europe, Erasmus+, LIFE, Digital Europe a ďalšie EÚ programy', url: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/' },
  { key: 'fpu', name: 'Fond na podporu umenia', desc: 'Výzvy FPU s podprogramami', url: 'https://www.fpu.sk' },
  { key: 'fnps', name: 'Fond na podporu športu', desc: 'Športová infraštruktúra a významné súťaže', url: 'https://www.fnps.sk' },
  { key: 'kultminor', name: 'Kultminor', desc: 'Fond na podporu kultúry národnostných menšín', url: 'https://www.kultminor.sk' },
  { key: 'avf', name: 'Audiovizuálny fond', desc: 'Výzvy AVF', url: 'https://www.avf.sk' },
  { key: 'manual', name: 'Ručne overené výzvy', desc: 'Kurátorsky pridané výzvy (nadácie, akcelerátory, národné projekty)', url: null },
];

app.get('/ucet/zdroje', auth.requireLogin, async (req, res) => {
  const [{ rows: counts }, { rows: tcount }, { rows: jobs }] = await Promise.all([
    pool.query(`SELECT source, count(*) FILTER (WHERE status='otvorena') AS otvorene, count(*) AS spolu, max(created_at) AS posledna FROM vyzvy GROUP BY source`),
    pool.query(`SELECT count(*) FILTER (WHERE deadline IS NULL OR deadline >= now()) AS otvorene, count(*) AS spolu, max(created_at) AS posledna FROM tenders`),
    pool.query(`SELECT key, value, updated_at FROM job_state ORDER BY key`),
  ]);
  const countMap = Object.fromEntries(counts.map((c) => [c.source, c]));
  res.render('zona/zdroje', { title: 'Zdroje dát', SOURCE_INFO, countMap, tenderStats: tcount[0], jobs });
});

// ---------- Cenník ----------
app.get('/cennik', (req, res) => res.render('cennik', { title: 'Cenník' }));

// ---------- CPV katalóg ----------
app.get('/cpv', async (req, res) => {
  const { rows: counts } = await pool.query(
    `SELECT substr(main_cpv, 1, 2) AS div, count(*)::int AS cnt
     FROM tenders WHERE main_cpv <> '' AND (deadline IS NULL OR deadline >= now())
     GROUP BY 1`);
  const countMap = Object.fromEntries(counts.map((r) => [r.div, r.cnt]));
  res.render('cpv', { title: 'CPV kódy', countMap, catalog: tcat.CPV_CATALOG });
});

// ---------- Služby ----------
app.get('/sluzby', (req, res) => res.render('sluzby', { title: 'Naše služby' }));

app.get('/sluzby/:slug', (req, res, next) => {
  const service = SERVICES.find((s) => s.slug === req.params.slug);
  if (!service) return next();
  res.render('sluzba', { title: service.name, service });
});

// ---------- Objednávka služby ----------
app.get('/objednavka', async (req, res) => {
  const service = SERVICES.find((s) => s.slug === req.query.sluzba) || SERVICES[0];
  let vyzva = null;
  let tender = null;
  if (req.query.vyzva) {
    const { rows } = await pool.query('SELECT id, slug, title FROM vyzvy WHERE slug = $1', [req.query.vyzva]);
    vyzva = rows[0] || null;
  }
  if (req.query.tender) {
    const { rows } = await pool.query('SELECT id, title FROM tenders WHERE id = $1', [Number(req.query.tender) || 0]);
    tender = rows[0] || null;
  }
  res.render('objednavka', { title: 'Nezáväzná objednávka', service, vyzva, tender, error: null, values: {} });
});

app.post('/objednavka', async (req, res) => {
  const service = SERVICES.find((s) => s.slug === req.body.sluzba) || SERVICES[0];
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    phone: String(req.body.phone || '').trim(),
    company: String(req.body.company || '').trim(),
    ico: String(req.body.ico || '').trim(),
    message: String(req.body.message || '').trim(),
  };
  let vyzva = null;
  let tender = null;
  if (req.body.vyzva) {
    const { rows } = await pool.query('SELECT id, slug, title FROM vyzvy WHERE slug = $1', [req.body.vyzva]);
    vyzva = rows[0] || null;
  }
  if (req.body.tender) {
    const { rows } = await pool.query('SELECT id, title FROM tenders WHERE id = $1', [Number(req.body.tender) || 0]);
    tender = rows[0] || null;
  }
  if (!values.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return res.status(400).render('objednavka', {
      title: 'Nezáväzná objednávka', service, vyzva, tender, values,
      error: 'Vyplňte meno a platný e-mail.',
    });
  }
  await pool.query(
    `INSERT INTO orders (user_id, service, vyzva_id, tender_id, name, email, phone, company, ico, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [req.session.userId || null, service.slug, vyzva ? vyzva.id : null, tender ? tender.id : null,
     values.name, values.email, values.phone, values.company, values.ico, values.message]
  );
  const ctx = vyzva ? `Výzva: ${vyzva.title}` : tender ? `Tender: ${tender.title}` : '';
  const summary =
    `Nová objednávka služby: ${service.name}\n` + (ctx ? ctx + '\n' : '') +
    `Meno: ${values.name}\nE-mail: ${values.email}\nTelefón: ${values.phone}\n` +
    `Firma: ${values.company} (IČO: ${values.ico})\nSpráva: ${values.message}`;
  const mailUi = require('./src/mailer');
  if (process.env.ORDERS_EMAIL) {
    await sendMail({
      to: process.env.ORDERS_EMAIL,
      subject: `Objednávka: ${service.name}`,
      text: summary,
      html: mailUi.shell({
        preheader: `Objednávka od ${values.name}`,
        heading: `Nová objednávka: ${service.name}`,
        introHtml: mailUi.para(ctx || 'Bez naviazania na konkrétnu výzvu/tender.'),
        bodyHtml: mailUi.itemCard({
          url: `mailto:${values.email}`,
          title: `${values.name} <${values.email}>`,
          subtitle: `${values.company || 'firma neuvedená'}${values.ico ? ` (IČO ${values.ico})` : ''}${values.phone ? ` · ${values.phone}` : ''}`,
          facts: values.message ? values.message.slice(0, 400) : '',
        }),
      }),
    });
  }
  await sendMail({
    to: values.email,
    subject: 'Prijali sme vašu objednávku',
    text: `Dobrý deň, ${values.name},\n\nprijali sme vašu nezáväznú objednávku služby „${service.name}“.` +
      (ctx ? `\n${ctx}` : '') +
      `\n\nOzveme sa vám s ďalším postupom.\n\nGrantHub`,
    html: mailUi.shell({
      preheader: 'Vaša objednávka je prijatá',
      heading: 'Objednávka prijatá',
      introHtml: mailUi.para(`Dobrý deň, ${values.name}, prijali sme vašu nezáväznú objednávku služby ${mailUi.strong(service.name)}.${ctx ? '<br>' + ctx : ''}`),
      bodyHtml:
        mailUi.small('Ozveme sa vám s ďalším postupom. Objednávka je nezáväzná — rozsah a konečnú cenu potvrdíme vopred.') +
        mailUi.button(`${process.env.BASE_URL || ''}/ucet`, 'Prehľad objednávok v účte'),
      reason: 'Tento e-mail ste dostali ako potvrdenie objednávky odoslanej na GrantHube.',
    }),
  });
  res.render('objednavka-ok', { title: 'Objednávka prijatá', service, values, vyzva, tender });
});

// ---------- Grantový radar ----------
app.get('/grantovy-radar', (req, res) =>
  res.render('radar', { title: 'Radar', ok: false, sent: false, devLink: null, error: null, values: {} })
);

app.post('/grantovy-radar', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const cats = [].concat(req.body.kategorie || []).filter((c) => CATEGORIES.includes(c));
  const tinds = [].concat(req.body.odvetvia || []).filter((k) => tcat.INDUSTRY_LABELS[k]);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).render('radar', {
      title: 'Radar', ok: false, sent: false, devLink: null,
      error: 'Zadajte platnú e-mailovú adresu.', values: { email, kategorie: cats, odvetvia: tinds },
    });
  }

  // Prihlásený používateľ so svojím e-mailom: potvrdené hneď, bez ďalšieho kroku
  const ownEmail = !!(res.locals.user && res.locals.user.email === email);
  await pool.query(
    `INSERT INTO radar_subscriptions (email, categories, tender_industries, confirmed) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET categories = EXCLUDED.categories,
       tender_industries = EXCLUDED.tender_industries,
       confirmed = radar_subscriptions.confirmed OR EXCLUDED.confirmed`,
    [email, cats.join('|'), tinds.join('|'), ownEmail]
  );
  if (ownEmail) {
    return res.render('radar', { title: 'Radar', ok: true, sent: false, devLink: null, error: null, values: { email, kategorie: cats, odvetvia: tinds } });
  }

  // Inak: potvrdenie odberu = registrácia — magic link potvrdí odber aj prihlási
  const { smtpConfigured } = require('./src/mailer');
  const link = await auth.sendMagicLink(req, email, {
    next: '/grantovy-radar/potvrdene',
    subject: 'Potvrďte odber grantového radaru',
    intro: 'odber grantového radaru potvrdíte kliknutím na tento odkaz (zároveň vás prihlási do účtu)',
  });
  res.render('radar', {
    title: 'Radar', ok: false, sent: true, error: null,
    devLink: !smtpConfigured && process.env.DEV_MODE === '1' ? link : null,
    values: { email, kategorie: cats, odvetvia: tinds },
  });
});

// Cieľ magic linku z radaru: používateľ je už prihlásený, potvrď odber
app.get('/grantovy-radar/potvrdene', auth.requireLogin, async (req, res) => {
  await pool.query('UPDATE radar_subscriptions SET confirmed = true WHERE email = $1', [req.session.email]);
  const { rows } = await pool.query('SELECT * FROM radar_subscriptions WHERE email = $1', [req.session.email]);
  const cats = rows.length && rows[0].categories ? rows[0].categories.split('|') : [];
  const tinds = rows.length && rows[0].tender_industries ? rows[0].tender_industries.split('|') : [];
  res.render('radar', {
    title: 'Radar', ok: true, sent: false, devLink: null, error: null,
    values: { email: req.session.email, kategorie: cats, odvetvia: tinds },
  });
});

// ---------- Segmentové stránky ----------
for (const seg of SEGMENTS) {
  app.get(`/${seg.slug}`, async (req, res) => {
    const { rows: vyzvy } = await pool.query(
      `SELECT * FROM vyzvy WHERE applicants ILIKE $1 AND status = 'otvorena'
         AND (deadline IS NULL OR deadline >= now()::date)
       ORDER BY deadline ASC NULLS LAST LIMIT 6`,
      [`%${seg.applicantKey}%`]
    );
    res.render('segment', { title: seg.title, seg, vyzvy });
  });
}

// ---------- Statické stránky ----------
app.get('/ako-fungujeme', (req, res) => res.render('ako-fungujeme', { title: 'Ako fungujeme' }));
app.get('/faq', (req, res) => res.render('faq', { title: 'Časté otázky' }));
app.get('/kontakt', (req, res) => res.render('kontakt', { title: 'Kontakt', ok: req.query.ok === '1', error: null, values: {} }));
app.post('/kontakt', async (req, res) => {
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    message: String(req.body.message || '').trim(),
  };
  if (!values.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || !values.message) {
    return res.status(400).render('kontakt', {
      title: 'Kontakt', ok: false, error: 'Vyplňte všetky polia a platný e-mail.', values,
    });
  }
  if (process.env.ORDERS_EMAIL) {
    await sendMail({
      to: process.env.ORDERS_EMAIL,
      subject: `Kontaktný formulár: ${values.name}`,
      text: `Od: ${values.name} <${values.email}>\n\n${values.message}`,
    });
  }
  res.redirect('/kontakt?ok=1');
});
app.get('/ochrana-osobnych-udajov', (req, res) => res.render('gdpr', { title: 'Ochrana osobných údajov' }));

// ---------- Účet ----------
app.get('/ucet', auth.requireLogin, async (req, res) => {
  const uid = req.session.userId;
  const [{ rows: saved }, { rows: orders }, { rows: radar }, { rows: savedTendre }] = await Promise.all([
    pool.query(
      `SELECT v.* FROM saved_vyzvy s JOIN vyzvy v ON v.id = s.vyzva_id
       WHERE s.user_id = $1 ORDER BY s.saved_at DESC`, [uid]),
    pool.query(`SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC`, [uid]),
    pool.query(`SELECT * FROM radar_subscriptions WHERE email = $1`, [req.session.email]),
    pool.query(
      `SELECT t.* FROM saved_tendre s JOIN tenders t ON t.id = s.tender_id
       WHERE s.user_id = $1 ORDER BY s.saved_at DESC`, [uid]),
  ]);
  res.render('ucet', {
    title: 'Môj účet', saved, orders, savedTendre,
    radar: radar[0] || null,
    savedMsg: req.query.ulozene === '1',
  });
});

app.post('/ucet', auth.requireLogin, async (req, res) => {
  await pool.query(
    'UPDATE users SET name = $1, company = $2, ico = $3 WHERE id = $4',
    [String(req.body.name || '').trim(), String(req.body.company || '').trim(),
     String(req.body.ico || '').trim(), req.session.userId]
  );
  res.redirect('/ucet?ulozene=1');
});

// ---------- Odhlásenie z radaru ----------
app.get('/grantovy-radar/odhlasit', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const token = String(req.query.t || '');
  if (!email || token !== unsubToken(email)) {
    return res.status(400).render('chyba', {
      title: 'Neplatný odkaz',
      heading: 'Odkaz na odhlásenie je neplatný',
      message: 'Skontrolujte, či ste odkaz z e-mailu skopírovali celý.',
      backLink: '/grantovy-radar', backLabel: 'Grantový radar',
    });
  }
  await pool.query('DELETE FROM radar_subscriptions WHERE email = $1', [email]);
  res.render('chyba', {
    title: 'Odber zrušený',
    heading: 'Odber grantového radaru je zrušený',
    message: `Na adresu ${email} už nebudeme posielať upozornenia. Kedykoľvek sa môžete prihlásiť znova.`,
    backLink: '/', backLabel: 'Späť na titulku',
  });
});

// ---------- Cron joby (Cloudflare Cron Triggers alebo externý plánovač) ----------
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (!PROD) return next(); // lokálny vývoj bez tajomstva
    return res.status(503).json({ error: 'CRON_SECRET nie je nastavený' });
  }
  if (req.get('authorization') === `Bearer ${secret}`) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.post('/cron/ingest', cronAuth, async (req, res, next) => {
  try {
    const stats = await runIngest();
    const scraped = await runScrapers();
    console.log('[cron] ingest:', JSON.stringify({ itms: stats, ...scraped }));
    res.json({ itms: stats, ...scraped });
  } catch (e) { next(e); }
});

app.post('/cron/tendre', cronAuth, async (req, res, next) => {
  try {
    const stats = await runTenderIngest();
    console.log('[cron] tendre:', JSON.stringify(stats));
    res.json(stats);
  } catch (e) { next(e); }
});

app.post('/cron/radar', cronAuth, async (req, res, next) => {
  try {
    const stats = await runRadar();
    console.log('[cron] radar:', JSON.stringify(stats));
    res.json(stats);
  } catch (e) { next(e); }
});

// ---------- 404 / error ----------
function notFound(req, res) {
  res.status(404).render('chyba', {
    title: 'Stránka nenájdená',
    heading: 'Stránka nenájdená',
    message: 'Stránka, ktorú hľadáte, neexistuje alebo bola presunutá.',
    backLink: '/', backLabel: 'Späť na titulnú stránku',
  });
}
app.use(notFound);
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('chyba', {
    title: 'Chyba servera',
    heading: 'Nastala neočakávaná chyba',
    message: 'Skúste to prosím o chvíľu znova.',
    backLink: '/', backLabel: 'Späť na titulnú stránku',
  });
});

// Interný plánovač — pre beh mimo Cloudflare (VPS, Docker). Na Cloudflare
// Containers ho nechajte vypnutý a použite Cron Triggers (worker.js).
function startInternalCron() {
  const SIX_H = 6 * 3600 * 1000;
  const tick = async () => {
    try { console.log('[cron] ingest:', JSON.stringify(await runIngest())); }
    catch (e) { console.error('[cron] ingest zlyhal:', e.message); }
    try { console.log('[cron] scrape:', JSON.stringify(await runScrapers())); }
    catch (e) { console.error('[cron] scrape zlyhal:', e.message); }
    try { console.log('[cron] tendre:', JSON.stringify(await runTenderIngest())); }
    catch (e) { console.error('[cron] tendre zlyhal:', e.message); }
    try { console.log('[cron] radar:', JSON.stringify(await runRadar())); }
    catch (e) { console.error('[cron] radar zlyhal:', e.message); }
  };
  setTimeout(tick, 15 * 1000);
  setInterval(tick, SIX_H);
  console.log('Interný cron zapnutý (ingest + radar každých 6 hodín).');
}

init()
  .then(() => {
    app.listen(PORT, () => console.log(`GrantHub beží na http://localhost:${PORT}`));
    if (process.env.ENABLE_INTERNAL_CRON === '1') startInternalCron();
  })
  .catch((e) => { console.error('Inicializácia DB zlyhala:', e); process.exit(1); });
