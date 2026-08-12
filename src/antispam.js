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

module.exports = { formToken, guard, looksGibberish };
