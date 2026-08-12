// Ochrana verejných formulárov pred spam botmi — bez externých služieb (CSP-friendly):
//   1. honeypot — skryté pole „website“; človek ho nevidí, bot ho vyplní
//   2. časová pasca — podpísaný timestamp; odoslanie do pár sekúnd od načítania = bot
//   3. heuristiky — voliteľné kontroly obsahu (napr. gibberish meno aj správa)
// Každý zachytený pokus sa eviduje v tabuľke spam_events (admin → /admin/spam).

const crypto = require('crypto');
const { pool } = require('./db');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-zmen-v-produkcii';
const MAX_AGE_MS = 2 * 3600 * 1000; // formulár otvorený max 2 h

const sign = (ts) => crypto.createHmac('sha256', SECRET).update(`form:${ts}`).digest('hex').slice(0, 16);

// Podpísaný timestamp do skrytého poľa formulára
function formToken() {
  const ts = Date.now().toString(36);
  return `${ts}.${sign(ts)}`;
}

// null = OK, inak dôvod odmietnutia
function checkToken(raw, minMs) {
  const [ts, sig] = String(raw || '').split('.');
  if (!ts || !sig) return 'token-chyba';
  if (sig !== sign(ts)) return 'token-podpis';
  const age = Date.now() - parseInt(ts, 36);
  if (!(age >= 0) || age > MAX_AGE_MS) return 'token-expirovany';
  if (age < minMs) return 'prilis-rychle';
  return null;
}

// Náhodné reťazce bez samohlások a medzier („vnhhphvgvf“)
function looksGibberish(s) {
  const t = String(s || '').trim();
  if (t.length < 8 || /\s/.test(t)) return false;
  const vowels = (t.toLowerCase().match(/[aeiouyáäéěíóôöúůüý]/g) || []).length;
  return vowels / t.length < 0.2;
}

async function logSpam(req, reason) {
  const payload = JSON.stringify(req.body || {}).slice(0, 500);
  await pool.query(
    `INSERT INTO spam_events (path, reason, ip, user_agent, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.path.slice(0, 300), reason, String(req.ip || '').slice(0, 60),
     String(req.get('user-agent') || '').slice(0, 300), payload]
  ).catch((e) => console.error('[antispam-log]', e.message));
}

// Middleware pre POST handlery verejných formulárov.
//   minMs      — minimálny čas od načítania formulára (bot odosiela okamžite)
//   heuristics — pole funkcií (body) => dôvod | null
function guard({ minMs = 3000, heuristics = [] } = {}) {
  return async (req, res, next) => {
    // 1. honeypot
    if (String(req.body.website || '').trim()) {
      await logSpam(req, 'honeypot');
      // tvárime sa, že prešlo — bot sa nemá z čoho učiť
      return res.redirect(`${req.path}?ok=1`);
    }
    // 2. časová pasca
    const tokenErr = checkToken(req.body.fts, minMs);
    if (tokenErr) {
      await logSpam(req, tokenErr);
      return res.status(400).render('chyba', {
        title: 'Skúste to znova',
        heading: 'Formulár sa nepodarilo odoslať',
        message: 'Overenie formulára zlyhalo — načítajte stránku a odošlite ho prosím znova.',
        backLink: req.path,
        backLabel: 'Späť na formulár',
      });
    }
    // 3. heuristiky obsahu
    for (const h of heuristics) {
      const reason = h(req.body);
      if (reason) {
        await logSpam(req, reason);
        return res.redirect(`${req.path}?ok=1`);
      }
    }
    next();
  };
}

// ─── Vyhodnocovanie anomálií (volané z cronu á 6 h) ───
// Ak počet zachytených pokusov za 24 h prekročí prah A zároveň výrazne
// prevyšuje bežný priemer, pošle admin alert. Max 1 alert za 24 h (job_state).

const ALERT_MIN_24H = 20;   // absolútny prah
const ALERT_RATIO = 3;      // násobok 7-dňového priemeru

async function spikeCheck() {
  const { sendMail } = require('./mailer'); // lazy — vyhne sa cyklickému importu
  const { rows: [m] } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24,
      (count(*) FILTER (WHERE created_at BETWEEN now() - interval '8 days' AND now() - interval '1 day') / 7.0) AS avg7,
      count(DISTINCT ip) FILTER (WHERE created_at > now() - interval '24 hours')::int AS ips24
    FROM spam_events`);
  const avg7 = Number(m.avg7) || 0;
  const spike = m.last24 >= ALERT_MIN_24H && m.last24 > ALERT_RATIO * Math.max(avg7, 1);
  if (!spike) return { spike: false, last24: m.last24 };

  // guard: max 1 alert za 24 h
  const { rows: st } = await pool.query(`SELECT value, updated_at FROM job_state WHERE key = 'spam_alert_last'`);
  if (st.length && Date.now() - new Date(st[0].updated_at).getTime() < 24 * 3600 * 1000) {
    return { spike: true, last24: m.last24, alerted: false };
  }
  const { rows: reasons } = await pool.query(`
    SELECT reason, count(*)::int AS n FROM spam_events
    WHERE created_at > now() - interval '24 hours' GROUP BY reason ORDER BY n DESC`);
  const admin = (process.env.ADMIN_EMAILS || 'filip@ques.sk').split(',')[0].trim();
  await sendMail({
    to: admin,
    subject: `GrantHub: nárast spam útokov — ${m.last24} pokusov za 24 h`,
    text: `Ochrana formulárov zachytila za posledných 24 hodín ${m.last24} pokusov z ${m.ips24} IP adries (bežný priemer ${avg7.toFixed(1)}/deň).\n\nRozpad podľa dôvodu:\n${reasons.map((r) => `- ${r.reason}: ${r.n}`).join('\n')}\n\nDetail: https://granthub.sk/admin/spam`,
  }).catch((e) => console.error('[spam-alert]', e.message));
  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('spam_alert_last', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [String(m.last24)]);
  console.log('[spam-alert] odoslaný:', m.last24, 'pokusov/24h');
  return { spike: true, last24: m.last24, alerted: true };
}

module.exports = { formToken, guard, looksGibberish, spikeCheck };
