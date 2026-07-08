const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const mail = require('./mailer');
const { sendMail, smtpConfigured } = mail;

const router = express.Router();
const TOKEN_TTL_MIN = 15;

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/prihlasenie', (req, res) => {
  if (req.session.userId) return res.redirect('/ucet');
  res.render('prihlasenie', { title: 'Prihlásenie', error: null, next: req.query.next || '', register: false });
});

router.get('/registracia', (req, res) => {
  if (req.session.userId) return res.redirect('/ucet');
  res.render('prihlasenie', { title: 'Registrácia', error: null, next: req.query.next || '', register: true });
});

// Vytvorí jednorazový token a pošle magic link; vracia link (na dev fallback)
async function sendMagicLink(req, email, { next = '', subject, intro } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO login_tokens (token, email, expires_at)
     VALUES ($1, $2, now() + interval '${TOKEN_TTL_MIN} minutes')`,
    [token, email]
  );
  const link = `${baseUrl(req)}/auth/overit?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  const finalSubject = subject || 'Prihlásenie do GrantHubu';
  const heading = subject && subject.includes('registráci') ? 'Vitajte! Dokončite registráciu'
    : subject && subject.includes('odber') ? 'Potvrďte odber radaru'
    : 'Prihlásenie do GrantHubu';
  const label = heading.includes('registráci') ? 'Dokončiť registráciu'
    : heading.includes('odber') ? 'Potvrdiť odber a prihlásiť sa'
    : 'Prihlásiť sa';
  const html = mail.shell({
    preheader: `Váš odkaz (platí ${TOKEN_TTL_MIN} minút)`,
    heading,
    introHtml: mail.para(`Dobrý deň, ${intro || 'na prihlásenie kliknite na tlačidlo nižšie'} — bez hesla.`),
    bodyHtml:
      mail.button(link, label) +
      mail.small(`Odkaz je platný <strong>${TOKEN_TTL_MIN} minút</strong> a použije sa iba raz.`) +
      mail.small(`Ak tlačidlo nefunguje, skopírujte do prehliadača túto adresu:<br><span style="word-break:break-all;color:#004494">${link}</span>`) +
      mail.small('Tento e-mail ste dostali, lebo niekto zadal vašu adresu v GrantHube. Ak ste to neboli vy, e-mail pokojne ignorujte — bez kliknutia sa nič nestane.'),
  });
  await sendMail({
    to: email,
    subject: finalSubject,
    text: `Dobrý deň,\n\n${intro || 'na prihlásenie kliknite na tento odkaz'} (platí ${TOKEN_TTL_MIN} minút):\n\n${link}\n\nAk ste o tento e-mail nežiadali, ignorujte ho.`,
    html,
  });
  return link;
}

router.post('/prihlasenie', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  let next = String(req.body.next || '');
  const register = req.body.register === '1';
  if (!EMAIL_RE.test(email)) {
    return res.status(400).render('prihlasenie', {
      title: register ? 'Registrácia' : 'Prihlásenie',
      error: 'Zadajte platnú e-mailovú adresu.',
      next, register,
    });
  }

  // Registrácia so záujmami: rovno založ radar (potvrdí sa kliknutím na magic link)
  if (register) {
    const { CATEGORIES } = require('./data');
    const { INDUSTRY_LABELS } = require('./tender-catalog');
    const cats = [].concat(req.body.kategorie || []).filter((c) => CATEGORIES.includes(c));
    const inds = [].concat(req.body.odvetvia || []).filter((k) => INDUSTRY_LABELS[k]);
    const ico = String(req.body.ico || '').replace(/\D/g, '').slice(0, 12);
    if (ico.length >= 6) {
      await pool.query(
        `INSERT INTO users (email, ico) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET ico = COALESCE(NULLIF(users.ico,''), EXCLUDED.ico)`,
        [email, ico]);
    }
    if (cats.length || inds.length) {
      await pool.query(
        `INSERT INTO radar_subscriptions (email, categories, tender_industries, confirmed)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (email) DO UPDATE SET categories = EXCLUDED.categories,
           tender_industries = EXCLUDED.tender_industries`,
        [email, cats.join('|'), inds.join('|')]
      );
      if (!next) next = '/grantovy-radar/potvrdene';
    }
  }

  const link = await sendMagicLink(req, email, {
    next,
    subject: register ? 'Dokončite registráciu v GrantHube' : 'Prihlásenie do GrantHubu',
    intro: register ? 'registráciu dokončíte kliknutím na tento odkaz' : 'na prihlásenie kliknite na tento odkaz',
  });

  res.render('link-odoslany', {
    title: 'Skontrolujte si e-mail',
    email,
    // odkaz na stránke je len núdzový režim, keď nie je nakonfigurované SMTP
    devLink: !smtpConfigured && process.env.DEV_MODE === '1' ? link : null,
  });
});

router.get('/auth/overit', async (req, res) => {
  const token = String(req.query.token || '');
  const next = String(req.query.next || '');
  // Token sa NEspotrebúva pri GET — e-mailové bezpečnostné skenery (Safe Links,
  // Mimecast…) odkaz automaticky otvoria a jednorazový token by tým znehodnotili.
  // Overíme len platnosť a zobrazíme potvrdzovacie tlačidlo (skenery nerobia POST).
  const { rows } = await pool.query(
    `SELECT email FROM login_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
    [token]
  );
  if (!rows.length) {
    return res.status(400).render('chyba', {
      title: 'Neplatný odkaz',
      heading: 'Prihlasovací odkaz je neplatný alebo expirovaný',
      message: 'Odkaz platí 15 minút a dá sa použiť len raz. Požiadajte o nový.',
      backLink: '/prihlasenie',
      backLabel: 'Späť na prihlásenie',
    });
  }
  res.render('overit', { title: 'Potvrďte prihlásenie', token, next, email: rows[0].email });
});

router.post('/auth/overit', async (req, res) => {
  const token = String(req.body.token || '');
  const next = String(req.body.next || '');
  const { rows } = await pool.query(
    `UPDATE login_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [token]
  );
  if (!rows.length) {
    return res.status(400).render('chyba', {
      title: 'Neplatný odkaz',
      heading: 'Prihlasovací odkaz je neplatný alebo expirovaný',
      message: 'Odkaz platí 15 minút a dá sa použiť len raz. Požiadajte o nový.',
      backLink: '/prihlasenie',
      backLabel: 'Späť na prihlásenie',
    });
  }

  const email = rows[0].email;
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );

  req.session.regenerate((err) => {
    if (err) return res.status(500).render('chyba', {
      title: 'Chyba',
      heading: 'Prihlásenie zlyhalo',
      message: 'Skúste to prosím znova.',
      backLink: '/prihlasenie',
      backLabel: 'Späť na prihlásenie',
    });
    req.session.userId = userRows[0].id;
    req.session.email = email;
    res.redirect(next && next.startsWith('/') ? next : '/ucet');
  });
});

router.post('/odhlasenie', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

async function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session.userId) {
    const { rows } = await pool.query(
      'SELECT id, email, name, company, ico FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (rows.length) res.locals.user = rows[0];
    else req.session.destroy(() => {});
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect(`/prihlasenie?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

module.exports = { router, loadUser, requireLogin, sendMagicLink };
