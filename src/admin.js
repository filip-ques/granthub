// Admin zóna — len pre e-maily v ADMIN_EMAILS (default filip@ques.sk).

const express = require('express');
const { pool } = require('./db');
const { CATEGORIES, APPLICANTS, SERVICES } = require('./data');

const router = express.Router();

function adminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS || 'filip@ques.sk')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
}

function isAdmin(user) {
  return !!user && adminEmails().has(user.email.toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect(`/prihlasenie?next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (!isAdmin(res.locals.user)) {
    return res.status(403).render('chyba', {
      title: 'Prístup zamietnutý',
      heading: 'Prístup zamietnutý',
      message: 'Admin zóna je dostupná len pre správcu portálu.',
      backLink: '/', backLabel: 'Späť na titulku',
    });
  }
  next();
}

router.use('/admin', requireAdmin);

router.get('/admin', async (req, res) => {
  const [kpi, jobs, lastOrders] = await Promise.all([
    pool.query(`SELECT
      (SELECT count(*)::int FROM vyzvy WHERE status = 'otvorena') AS otvorene,
      (SELECT count(*)::int FROM vyzvy WHERE source = 'itms') AS itms,
      (SELECT count(*)::int FROM vyzvy WHERE source = 'manual') AS manualne,
      (SELECT count(*)::int FROM tenders) AS tendre,
      (SELECT count(*)::int FROM tenders WHERE deadline IS NULL OR deadline >= now()) AS tendre_otvorene,
      (SELECT count(*)::int FROM users) AS pouzivatelia,
      (SELECT count(*)::int FROM radar_subscriptions) AS odbery,
      (SELECT count(*)::int FROM orders WHERE status = 'nova') AS nove_objednavky`),
    pool.query(`SELECT key, value, updated_at FROM job_state ORDER BY key`),
    pool.query(`SELECT o.*, v.title AS vyzva_title FROM orders o
                LEFT JOIN vyzvy v ON v.id = o.vyzva_id
                ORDER BY o.created_at DESC LIMIT 5`),
  ]);
  res.render('admin/dashboard', {
    title: 'Admin',
    kpi: kpi.rows[0], jobs: jobs.rows, lastOrders: lastOrders.rows,
  });
});

router.get('/admin/vyzvy', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) { params.push(`%${q}%`); where = `WHERE title ILIKE $1 OR slug ILIKE $1 OR coalesce(provider,'') ILIKE $1`; }
  const { rows: vyzvy } = await pool.query(
    `SELECT id, slug, title, provider, category, status, source, deadline FROM vyzvy ${where}
     ORDER BY (status = 'otvorena') DESC, created_at DESC LIMIT 300`, params);
  res.render('admin/vyzvy', { title: 'Admin — výzvy', vyzvy, q });
});

const VYZVA_FIELDS = ['title', 'provider', 'program', 'category', 'applicants', 'regions',
  'summary', 'details', 'source_url', 'status', 'deadline_note'];

function vyzvaFromBody(body) {
  const v = {};
  for (const f of VYZVA_FIELDS) v[f] = String(body[f] || '').trim() || null;
  v.amount_min = body.amount_min ? Number(body.amount_min) : null;
  v.amount_max = body.amount_max ? Number(body.amount_max) : null;
  v.allocation = body.allocation ? Number(body.allocation) : null;
  v.deadline = body.deadline || null;
  v.title = v.title || 'Bez názvu';
  v.category = v.category || 'Eurofondy';
  v.applicants = v.applicants || 'podľa dokumentácie výzvy';
  v.regions = v.regions || 'Celé Slovensko';
  v.summary = v.summary || v.title;
  v.status = v.status === 'uzavreta' ? 'uzavreta' : 'otvorena';
  return v;
}

router.get('/admin/vyzvy/nova', (req, res) => {
  res.render('admin/vyzva-edit', { title: 'Nová výzva', vyzva: null });
});

router.post('/admin/vyzvy/nova', async (req, res) => {
  const v = vyzvaFromBody(req.body);
  const slug = String(req.body.slug || '').trim() ||
    v.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
  await pool.query(
    `INSERT INTO vyzvy (slug, title, provider, program, category, applicants, regions,
                        amount_min, amount_max, allocation, deadline, deadline_note,
                        summary, details, source_url, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual')
     ON CONFLICT (slug) DO NOTHING`,
    [slug, v.title, v.provider, v.program, v.category, v.applicants, v.regions,
     v.amount_min, v.amount_max, v.allocation, v.deadline, v.deadline_note,
     v.summary, v.details, v.source_url, v.status]
  );
  res.redirect('/admin/vyzvy');
});

router.get('/admin/vyzvy/:id', async (req, res, next) => {
  const { rows } = await pool.query('SELECT * FROM vyzvy WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rows.length) return next();
  res.render('admin/vyzva-edit', { title: 'Upraviť výzvu', vyzva: rows[0] });
});

router.post('/admin/vyzvy/:id', async (req, res) => {
  const v = vyzvaFromBody(req.body);
  await pool.query(
    `UPDATE vyzvy SET title=$1, provider=$2, program=$3, category=$4, applicants=$5, regions=$6,
       amount_min=$7, amount_max=$8, allocation=$9, deadline=$10, deadline_note=$11,
       summary=$12, details=$13, source_url=$14, status=$15
     WHERE id = $16`,
    [v.title, v.provider, v.program, v.category, v.applicants, v.regions,
     v.amount_min, v.amount_max, v.allocation, v.deadline, v.deadline_note,
     v.summary, v.details, v.source_url, v.status, Number(req.params.id) || 0]
  );
  res.redirect('/admin/vyzvy');
});

router.post('/admin/vyzvy/:id/zmazat', async (req, res) => {
  await pool.query('DELETE FROM vyzvy WHERE id = $1', [Number(req.params.id) || 0]);
  res.redirect('/admin/vyzvy');
});

router.get('/admin/objednavky', async (req, res) => {
  const { rows: orders } = await pool.query(
    `SELECT o.*, v.title AS vyzva_title, v.slug AS vyzva_slug FROM orders o
     LEFT JOIN vyzvy v ON v.id = o.vyzva_id ORDER BY o.created_at DESC LIMIT 300`);
  res.render('admin/objednavky', { title: 'Admin — objednávky', orders, SERVICES });
});

router.post('/admin/objednavky/:id', async (req, res) => {
  const status = ['nova', 'v-rieseni', 'vybavena', 'zrusena'].includes(req.body.status)
    ? req.body.status : 'nova';
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, Number(req.params.id) || 0]);
  res.redirect('/admin/objednavky');
});

router.get('/admin/pouzivatelia', async (req, res) => {
  const { rows: users } = await pool.query(
    `SELECT u.*,
       (SELECT count(*)::int FROM saved_vyzvy s WHERE s.user_id = u.id) AS ulozene_vyzvy,
       (SELECT count(*)::int FROM saved_tendre s WHERE s.user_id = u.id) AS ulozene_tendre,
       (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id) AS objednavky,
       (SELECT count(*)::int FROM tender_searches t WHERE t.user_id = u.id) AS straznici,
       (SELECT confirmed FROM radar_subscriptions r WHERE r.email = u.email) AS radar,
       (SELECT max(created_at) FROM activity_events e WHERE e.user_id = u.id) AS posledna_aktivita
     FROM users u ORDER BY u.created_at DESC LIMIT 500`);
  res.render('admin/pouzivatelia', { title: 'Admin — používatelia', users });
});

router.get('/admin/aktivita', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) { params.push(`%${q}%`); where = `WHERE (e.path ILIKE $1 OR e.ip ILIKE $1 OR u.email ILIKE $1)`; }
  const { rows: events } = await pool.query(
    `SELECT e.*, u.email FROM activity_events e LEFT JOIN users u ON u.id = e.user_id
     ${where} ORDER BY e.created_at DESC LIMIT 200`, params);
  const { rows: [stats] } = await pool.query(
    `SELECT count(*)::int AS spolu,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS za_24h,
       count(DISTINCT ip) FILTER (WHERE created_at > now() - interval '24 hours')::int AS ip_24h
     FROM activity_events`);
  res.render('admin/aktivita', { title: 'Admin — aktivita', events, stats, q });
});

router.get('/admin/odbery', async (req, res) => {
  const { rows: subs } = await pool.query(
    `SELECT * FROM radar_subscriptions ORDER BY created_at DESC LIMIT 500`);
  res.render('admin/odbery', { title: 'Admin — odbery', subs });
});

router.post('/admin/odbery/:id/zmazat', async (req, res) => {
  await pool.query('DELETE FROM radar_subscriptions WHERE id = $1', [Number(req.params.id) || 0]);
  res.redirect('/admin/odbery');
});

module.exports = { router, isAdmin };
