// Modul obstarávania — umožňuje registrovaným používateľom vytvoriť
// vlastné obstarávanie (mini-tender), nahrať podklady, pozvať dodávateľov
// e-mailom (magic link na token-based portál) a zbierať ponuky vo viacerých kolách.
//
// Inšpirované systémom iTender HANT, prispôsobené na multi-tenant GrantHub.

const { Router } = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { pool } = require('./db');
const { sendMail, shell, button, para, small, strong, itemCard, sectionHeading, esc } = require('./mailer');
const { buildFullPdf, buildZip } = require('./report');

const router = Router();
const portal = Router();

// Multer: memory storage → BYTEA v Postgres (max 25 MB/súbor, max 10 súborov)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const newToken = () => crypto.randomBytes(24).toString('hex');

const STAVY = {
  priprava: { label: 'Príprava', cls: 'muted' },
  prebieha: { label: 'Prebieha', cls: 'brand' },
  vyhodnotenie: { label: 'Vyhodnotenie', cls: 'accent' },
  ukoncene: { label: 'Ukončené', cls: 'ok' },
  zrusene: { label: 'Zrušené', cls: '' },
};

const KATEGORIE = { projekt: 'Projektová dokumentácia', vv: 'Výkaz výmer', zmluva: 'Zmluva / dodatok', ine: 'Iné' };

// ─── helpers ───

// Jednotný notifikačný e-mail; neblokuje flow — chybu len zaloguje.
// intro/bodyHtml sú HTML — user-controlled hodnoty musí volajúci escapovať cez esc().
function notify({ to, subject, heading, intro, bodyHtml = '', link, linkLabel, reason }) {
  const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  return sendMail({
    to,
    subject: cleanSubject,
    text: `${heading}\n\n${String(intro).replace(/<[^>]+>/g, '')}${link ? `\n\n${link}` : ''}`,
    html: shell({
      preheader: esc(cleanSubject),
      heading,
      introHtml: para(intro),
      bodyHtml: bodyHtml + (link ? button(link, linkLabel || 'Zobraziť') : ''),
      reason: reason || 'Tento e-mail ste dostali ako účastník obstarávania cez portál GrantHub.',
    }),
  }).catch((e) => console.error('[obst-notify]', to, e.message));
}

const baseUrlOf = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

// Jednoduchý in-memory rate limit pre portálové POSTy (token nevyžaduje prihlásenie)
const portalBuckets = new Map();
function portalLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.params.token}:${req.ip}`;
    const now = Date.now();
    const fresh = (portalBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (fresh.length >= max) return res.status(429).send('Priveľa požiadaviek, skúste o chvíľu.');
    fresh.push(now);
    portalBuckets.set(key, fresh);
    if (portalBuckets.size > 5000) portalBuckets.clear(); // poistka proti rastu pamäte
    next();
  };
}

// Overí, že obstarávanie patrí prihlásenému používateľovi
async function loadOwn(req) {
  const { rows } = await pool.query('SELECT * FROM obstaravania WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  return rows[0] || null;
}

// Načíta všetky dáta pre detail (kolá, dodávateľov, ponuky, podklady, správy)
async function detailData(obst) {
  const id = obst.id;
  const [kola, dod, podklady, ponuky, spravy] = await Promise.all([
    pool.query('SELECT * FROM obstaravanie_kola WHERE obstaravanie_id = $1 ORDER BY cislo', [id]),
    pool.query('SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id = $1 ORDER BY created_at', [id]),
    pool.query(`SELECT p.*, s.nazov AS subor_nazov, s.mime, s.velkost
                FROM obstaravanie_podklady p JOIN subory s ON s.id = p.subor_id
                WHERE p.obstaravanie_id = $1 ORDER BY p.id`, [id]),
    pool.query(`SELECT p.*, k.cislo AS kolo_cislo, d.email AS dod_email, d.nazov AS dod_nazov
                FROM obstaravanie_ponuky p
                JOIN obstaravanie_kola k ON k.id = p.kolo_id
                JOIN obstaravanie_dodavatelia d ON d.id = p.dodavatel_id
                WHERE k.obstaravanie_id = $1 ORDER BY k.cislo, d.nazov`, [id]),
    pool.query(`SELECT sp.*, d.email AS dod_email, d.nazov AS dod_nazov
                FROM obstaravanie_spravy sp JOIN obstaravanie_dodavatelia d ON d.id = sp.dodavatel_id
                WHERE d.obstaravanie_id = $1 ORDER BY sp.created_at DESC LIMIT 200`, [id]),
  ]);
  return {
    kola: kola.rows,
    dodavatelia: dod.rows,
    podklady: podklady.rows,
    ponuky: ponuky.rows,
    spravy: spravy.rows,
    otvoreneKolo: kola.rows.find((k) => k.stav === 'otvorene') || null,
  };
}

// ═══════════════════════════════════════════════════════════════
// OBSTARÁVATEĽSKÁ ZÓNA (vyžaduje prihlásenie)
// ═══════════════════════════════════════════════════════════════

// Zoznam obstarávaní
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*,
       (SELECT count(*) FROM obstaravanie_dodavatelia d WHERE d.obstaravanie_id = o.id) AS dodavatelov,
       (SELECT count(*) FROM obstaravanie_ponuky p JOIN obstaravanie_kola k ON k.id = p.kolo_id WHERE k.obstaravanie_id = o.id) AS ponuk
     FROM obstaravania o WHERE o.user_id = $1 ORDER BY o.created_at DESC`, [req.session.userId]);
  res.render('zona/obstaravania', { title: 'Moje obstarávania', items: rows, STAVY });
});

// Formulár nového obstarávania
router.get('/nove', (req, res) => {
  res.render('zona/obstaravanie-nove', { title: 'Nové obstarávanie', error: null, values: {} });
});

// Vytvoriť obstarávanie + 1. kolo
router.post('/', async (req, res) => {
  const nazov = String(req.body.nazov || '').trim();
  const popis = String(req.body.popis || '').trim();
  const rozpocet = req.body.rozpocet ? Number(req.body.rozpocet) || null : null;
  const termin = req.body.termin_ponuky || null;
  if (!nazov) {
    return res.status(400).render('zona/obstaravanie-nove', {
      title: 'Nové obstarávanie', error: 'Zadajte názov obstarávania.', values: req.body,
    });
  }
  const { rows } = await pool.query(
    `INSERT INTO obstaravania (user_id, nazov, popis, rozpocet, termin_ponuky) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.session.userId, nazov, popis, rozpocet, termin]);
  const obstId = rows[0].id;
  // Automaticky vytvor 1. kolo
  await pool.query('INSERT INTO obstaravanie_kola (obstaravanie_id, cislo, termin) VALUES ($1, 1, $2)', [obstId, termin]);
  res.redirect(`/ucet/obstaravania/${obstId}`);
});

// Detail obstarávania (tabs)
router.get('/:id', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const data = await detailData(obst);
  const tab = req.query.tab || 'prehlad';
  res.render('zona/obstaravanie', { title: obst.nazov, obst, ...data, tab, STAVY, KATEGORIE });
});

// Aktualizovať metadata
router.post('/:id', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const nazov = String(req.body.nazov || '').trim() || obst.nazov;
  const popis = String(req.body.popis || '').trim();
  const rozpocet = req.body.rozpocet ? Number(req.body.rozpocet) || null : null;
  const termin = req.body.termin_ponuky || null;
  await pool.query(
    'UPDATE obstaravania SET nazov=$1, popis=$2, rozpocet=$3, termin_ponuky=$4, updated_at=now() WHERE id=$5',
    [nazov, popis, rozpocet, termin, obst.id]);
  // Ak sa zmenil termín, aktualizuj aj otvorené kolo
  if (termin) {
    await pool.query(`UPDATE obstaravanie_kola SET termin=$1 WHERE obstaravanie_id=$2 AND stav='otvorene'`, [termin, obst.id]);
  }
  res.redirect(`/ucet/obstaravania/${obst.id}`);
});

// ─── Podklady (dokumenty) ───

router.post('/:id/podklady', upload.array('subory'), async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const kategoria = KATEGORIE[req.body.kategoria] ? req.body.kategoria : 'ine';
  const popis = String(req.body.popis || '').trim();
  for (const f of (req.files || [])) {
    const { rows } = await pool.query(
      'INSERT INTO subory (nazov, mime, velkost, data) VALUES ($1,$2,$3,$4) RETURNING id',
      [f.originalname, f.mimetype, f.size, f.buffer]);
    await pool.query(
      'INSERT INTO obstaravanie_podklady (obstaravanie_id, subor_id, kategoria, popis) VALUES ($1,$2,$3,$4)',
      [obst.id, rows[0].id, kategoria, popis]);
  }
  // Ak už boli dodávatelia oslovení, upozorni ich na doplnené podklady
  if ((req.files || []).length && obst.stav === 'prebieha') {
    const nazvy = (req.files || []).map((f) => f.originalname).join(', ');
    const firma = res.locals.user.company || res.locals.user.email;
    const { rows: dods } = await pool.query(
      `SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND stav IN ('osloveny','vybrany')`, [obst.id]);
    for (const d of dods) {
      notify({
        to: d.email,
        subject: `Doplnené podklady: ${obst.nazov}`,
        heading: 'Obstarávateľ doplnil podklady',
        intro: `Obstarávateľ ${strong(esc(firma))} doplnil podklady k obstarávaniu ${strong(esc(obst.nazov))}: ${esc(nazvy)}.`,
        link: `${baseUrlOf(req)}/obstaravanie/${d.token}?tab=podklady`,
        linkLabel: 'Zobraziť podklady',
      });
    }
  }
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=podklady`);
});

router.post('/:id/podklady/:pid/zmazat', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  await pool.query('DELETE FROM obstaravanie_podklady WHERE id=$1 AND obstaravanie_id=$2', [req.params.pid, obst.id]);
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=podklady`);
});

// Stiahnuť súbor (len vlastník)
router.get('/:id/subor/:sid', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const { rows } = await pool.query(
    `SELECT s.* FROM subory s WHERE s.id = $1 AND (
       EXISTS (SELECT 1 FROM obstaravanie_podklady p WHERE p.subor_id = s.id AND p.obstaravanie_id = $2)
       OR EXISTS (SELECT 1 FROM obstaravanie_ponuka_subory ps JOIN obstaravanie_ponuky po ON po.id = ps.ponuka_id
                  JOIN obstaravanie_kola k ON k.id = po.kolo_id WHERE ps.subor_id = s.id AND k.obstaravanie_id = $2)
    )`, [req.params.sid, obst.id]);
  if (!rows.length) return next();
  const s = rows[0];
  res.set('Content-Type', s.mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(s.nazov)}"`);
  res.send(s.data);
});

// ─── Dodávatelia ───

router.post('/:id/dodavatelia', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  // emaily — textarea, jeden per riadok alebo čiarkou
  const raw = String(req.body.emaily || '');
  const emails = raw.split(/[\n,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  for (const email of emails) {
    const exists = await pool.query('SELECT 1 FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND email=$2', [obst.id, email]);
    if (exists.rows.length) continue;
    const nazov = String(req.body[`nazov_${email}`] || '').trim();
    await pool.query(
      'INSERT INTO obstaravanie_dodavatelia (obstaravanie_id, email, nazov, token) VALUES ($1,$2,$3,$4)',
      [obst.id, email, nazov, newToken()]);
  }
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=dodavatelia`);
});

router.post('/:id/dodavatelia/:did/vyradit', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  await pool.query(`UPDATE obstaravanie_dodavatelia SET stav='vyradeny' WHERE id=$1 AND obstaravanie_id=$2`, [req.params.did, obst.id]);
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=dodavatelia`);
});

// Odoslať pozvánky (magic link)
router.post('/:id/oslovit', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const { rows: novyDod } = await pool.query(
    `SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND stav='pozvany'`, [obst.id]);
  const user = res.locals.user;
  let sent = 0;
  for (const d of novyDod) {
    const link = `${base}/obstaravanie/${d.token}`;
    try {
      await sendMail({
        to: d.email,
        subject: `Výzva na predloženie ponuky: ${obst.nazov}`,
        text: `Dobrý deň,\n\nfirma ${user.company || user.email} vás pozýva predložiť cenovú ponuku na: ${obst.nazov}.\n\nPodrobnosti a odoslanie ponuky: ${link}\n\nGrantHub`,
        html: shell({
          preheader: `Nové obstarávanie: ${esc(obst.nazov)}`,
          heading: 'Výzva na predloženie ponuky',
          introHtml: para(`Firma ${strong(esc(user.company || user.email))} vás pozýva predložiť cenovú ponuku na obstarávanie:`),
          bodyHtml:
            itemCard({ url: link, title: esc(obst.nazov), subtitle: obst.popis ? esc(obst.popis.slice(0, 200)) : '',
              facts: obst.termin_ponuky ? `Termín: ${new Date(obst.termin_ponuky).toLocaleDateString('sk-SK')}` : '' }) +
            button(link, 'Zobraziť podrobnosti a podať ponuku') +
            small('Tento odkaz je určený výhradne vám. Na predloženie ponuky nie je potrebná registrácia.'),
          reason: `Tento e-mail ste dostali, pretože vás firma ${user.company || user.email} pozvala do obstarávania cez portál GrantHub.`,
        }),
      });
      await pool.query(`UPDATE obstaravanie_dodavatelia SET stav='osloveny' WHERE id=$1`, [d.id]);
      sent++;
    } catch (e) {
      console.error('[obst-invite]', d.email, e.message);
    }
  }
  // Ak je to prvé oslovenie, prepni stav na "prebieha"
  if (sent > 0 && obst.stav === 'priprava') {
    await pool.query(`UPDATE obstaravania SET stav='prebieha', updated_at=now() WHERE id=$1`, [obst.id]);
  }
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=dodavatelia&sent=${sent}`);
});

// ─── Kolá ───

// Otvoriť nové kolo
router.post('/:id/kola', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  // Uzavri aktuálne otvorené kolo
  await pool.query(`UPDATE obstaravanie_kola SET stav='uzavrete' WHERE obstaravanie_id=$1 AND stav='otvorene'`, [obst.id]);
  // Nové kolo
  const { rows: maxR } = await pool.query('SELECT COALESCE(MAX(cislo),0)+1 AS c FROM obstaravanie_kola WHERE obstaravanie_id=$1', [obst.id]);
  const cislo = maxR[0].c;
  const termin = req.body.termin || null;
  await pool.query('INSERT INTO obstaravanie_kola (obstaravanie_id, cislo, termin) VALUES ($1,$2,$3)', [obst.id, cislo, termin]);
  // Aktualizuj termín na obstarávaní
  if (termin) {
    await pool.query('UPDATE obstaravania SET termin_ponuky=$1, updated_at=now() WHERE id=$2', [termin, obst.id]);
  }
  // Notifikuj oslovených dodávateľov o novom kole
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const user = res.locals.user;
  const { rows: aktDod } = await pool.query(
    `SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND stav IN ('osloveny','vybrany')`, [obst.id]);
  for (const d of aktDod) {
    const link = `${base}/obstaravanie/${d.token}`;
    sendMail({
      to: d.email,
      subject: `Nové kolo obstarávania: ${obst.nazov} (kolo ${cislo})`,
      text: `Dobrý deň,\n\nv obstarávaní „${obst.nazov}" bolo otvorené kolo ${cislo}.\nPredložte novú ponuku: ${link}\n\nGrantHub`,
      html: shell({
        preheader: `Kolo ${cislo}: ${esc(obst.nazov)}`,
        heading: `Nové kolo obstarávania (kolo ${cislo})`,
        introHtml: para(`V obstarávaní ${strong(esc(obst.nazov))} bolo otvorené ${strong(`${cislo}. kolo`)}.`),
        bodyHtml:
          (termin ? small(`Termín na predloženie ponuky: ${new Date(termin).toLocaleDateString('sk-SK')}`) : '') +
          button(link, 'Predložiť ponuku'),
        reason: `Tento e-mail ste dostali ako účastník obstarávania cez portál GrantHub.`,
      }),
    }).catch((e) => console.error('[obst-kolo]', d.email, e.message));
  }
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=ponuky`);
});

// Uzavrieť kolo
router.post('/:id/kola/:kid/uzavriet', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const { rows: closed } = await pool.query(
    `UPDATE obstaravanie_kola SET stav='uzavrete' WHERE id=$1 AND obstaravanie_id=$2 AND stav='otvorene' RETURNING cislo`,
    [req.params.kid, obst.id]);
  if (closed.length) {
    // Ak už nie je otvorené žiadne kolo, prejdi do vyhodnotenia (len z 'prebieha' — nikdy nie z ukončeného/zrušeného)
    const { rows } = await pool.query(`SELECT 1 FROM obstaravanie_kola WHERE obstaravanie_id=$1 AND stav='otvorene'`, [obst.id]);
    if (!rows.length) {
      await pool.query(`UPDATE obstaravania SET stav='vyhodnotenie', updated_at=now() WHERE id=$1 AND stav='prebieha'`, [obst.id]);
    }
  }
  // Notifikuj dodávateľov, že kolo je uzavreté a prebieha vyhodnotenie
  if (closed.length) {
    const firma = res.locals.user.company || res.locals.user.email;
    const { rows: dods } = await pool.query(
      `SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND stav IN ('osloveny','vybrany')`, [obst.id]);
    for (const d of dods) {
      notify({
        to: d.email,
        subject: `Kolo ${closed[0].cislo} uzavreté: ${obst.nazov}`,
        heading: `${closed[0].cislo}. kolo bolo uzavreté`,
        intro: `Obstarávateľ ${strong(esc(firma))} uzavrel ${closed[0].cislo}. kolo obstarávania ${strong(esc(obst.nazov))}. Prebieha vyhodnotenie ponúk — o výsledku alebo prípadnom ďalšom kole vás budeme informovať e-mailom.`,
        link: `${baseUrlOf(req)}/obstaravanie/${d.token}`,
        linkLabel: 'Zobraziť moje ponuky',
      });
    }
  }
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=ponuky`);
});

// ─── Ponuky ───

router.post('/:id/ponuky/:pid/stav', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const stav = ['ok', 'vyradena'].includes(req.body.stav) ? req.body.stav : 'dorucena';
  const { rows } = await pool.query(
    `UPDATE obstaravanie_ponuky p SET stav=$1
     FROM obstaravanie_kola k, obstaravanie_dodavatelia d
     WHERE p.id=$2 AND k.id = p.kolo_id AND k.obstaravanie_id=$3 AND d.id = p.dodavatel_id
       AND p.stav IS DISTINCT FROM $1
     RETURNING p.suma, k.cislo AS kolo_cislo, d.email, d.nazov, d.token`,
    [stav, req.params.pid, obst.id]);
  // Notifikuj dodávateľa o zmene stavu jeho ponuky
  if (rows.length && (stav === 'ok' || stav === 'vyradena')) {
    const p = rows[0];
    const akceptovana = stav === 'ok';
    notify({
      to: p.email,
      subject: `${akceptovana ? 'Vaša ponuka bola akceptovaná' : 'Vaša ponuka bola zrušená'}: ${obst.nazov}`,
      heading: akceptovana ? 'Ponuka akceptovaná' : 'Ponuka zrušená',
      intro: `Obstarávateľ ${strong(esc(res.locals.user.company || res.locals.user.email))} ${akceptovana ? 'akceptoval' : 'zrušil'} vašu ponuku${p.suma ? ` (${Number(p.suma).toLocaleString('sk-SK')} € bez DPH)` : ''} v ${p.kolo_cislo}. kole obstarávania ${strong(esc(obst.nazov))}.`,
      bodyHtml: akceptovana ? small('Akceptovanie ponuky ešte neznamená výber víťaza — o výsledku obstarávania vás budeme informovať.') : small('V prípade otázok použite komunikáciu v dodávateľskom portáli.'),
      link: `${baseUrlOf(req)}/obstaravanie/${p.token}`,
      linkLabel: 'Otvoriť dodávateľský portál',
    });
  }
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=ponuky`);
});

// ─── Víťaz + ukončenie ───

router.post('/:id/vitaz', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const dodId = Number(req.body.dodavatel_id);
  // Idempotenčný guard: ukončiť možno len bežiace/vyhodnocované obstarávanie
  // (opakovaný submit nesmie znova rozoslať e-maily ani prepísať zrušené)
  const { rows: ch } = await pool.query(
    `UPDATE obstaravania SET stav='ukoncene', updated_at=now()
     WHERE id=$1 AND stav NOT IN ('ukoncene','zrusene') RETURNING id`, [obst.id]);
  if (!ch.length) return res.redirect(`/ucet/obstaravania/${obst.id}`);
  if (dodId) {
    await pool.query(`UPDATE obstaravanie_dodavatelia SET stav='vybrany' WHERE id=$1 AND obstaravanie_id=$2`, [dodId, obst.id]);
  }
  await pool.query(`UPDATE obstaravanie_kola SET stav='uzavrete' WHERE obstaravanie_id=$1 AND stav='otvorene'`, [obst.id]);
  // Notifikuj víťaza aj neúspešných dodávateľov o výsledku
  const firma = res.locals.user.company || res.locals.user.email;
  const { rows: dods } = await pool.query(
    `SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND stav IN ('osloveny','vybrany')`, [obst.id]);
  for (const d of dods) {
    const vitaz = d.id === dodId;
    notify({
      to: d.email,
      subject: `${vitaz ? 'Vaša ponuka uspela' : 'Obstarávanie bolo ukončené'}: ${obst.nazov}`,
      heading: vitaz ? 'Gratulujeme — vaša ponuka uspela' : 'Obstarávanie ukončené',
      intro: vitaz
        ? `Obstarávateľ ${strong(esc(firma))} vybral vašu ponuku ako víťaznú v obstarávaní ${strong(esc(obst.nazov))}. Obstarávateľ vás bude kontaktovať ohľadom ďalších krokov (zmluva, plnenie).`
        : `Obstarávateľ ${strong(esc(firma))} ukončil obstarávanie ${strong(esc(obst.nazov))}. Vaša ponuka tentoraz nebola vybraná. Ďakujeme za účasť a čas venovaný príprave ponuky.`,
      link: `${baseUrlOf(req)}/obstaravanie/${d.token}`,
      linkLabel: 'Zobraziť detail v portáli',
    });
  }
  res.redirect(`/ucet/obstaravania/${obst.id}`);
});

// Zrušiť
router.post('/:id/zrusit', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  // Idempotenčný guard — už ukončené/zrušené sa nedá zrušiť znova (žiadne duplicitné e-maily)
  const { rows: ch } = await pool.query(
    `UPDATE obstaravania SET stav='zrusene', updated_at=now()
     WHERE id=$1 AND stav NOT IN ('zrusene','ukoncene') RETURNING id`, [obst.id]);
  if (!ch.length) return res.redirect(`/ucet/obstaravania/${obst.id}`);
  await pool.query(`UPDATE obstaravanie_kola SET stav='uzavrete' WHERE obstaravanie_id=$1 AND stav='otvorene'`, [obst.id]);
  // Notifikuj oslovených dodávateľov o zrušení
  const { rows: dods } = await pool.query(
    `SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id=$1 AND stav IN ('osloveny','vybrany')`, [obst.id]);
  const firma = res.locals.user.company || res.locals.user.email;
  for (const d of dods) {
    notify({
      to: d.email,
      subject: `Obstarávanie bolo zrušené: ${obst.nazov}`,
      heading: 'Obstarávanie zrušené',
      intro: `Obstarávateľ ${strong(esc(firma))} zrušil obstarávanie ${strong(esc(obst.nazov))}. Predkladanie ponúk je ukončené a doručené ponuky nebudú vyhodnotené. Ďakujeme za váš záujem.`,
    });
  }
  res.redirect(`/ucet/obstaravania/${obst.id}`);
});

// ─── Správy ───

router.post('/:id/spravy/:did', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (!text) return res.redirect(`/ucet/obstaravania/${obst.id}?tab=komunikacia`);
  // Overí, že dodávateľ patrí k tomuto obstarávaniu
  const { rows } = await pool.query('SELECT * FROM obstaravanie_dodavatelia WHERE id=$1 AND obstaravanie_id=$2', [req.params.did, obst.id]);
  if (!rows.length) return next();
  await pool.query('INSERT INTO obstaravanie_spravy (dodavatel_id, smer, text) VALUES ($1,$2,$3)', [rows[0].id, 'obstaravatel', text]);
  // Notifikuj dodávateľa o novej správe
  notify({
    to: rows[0].email,
    subject: `Nová správa k obstarávaniu: ${obst.nazov}`,
    heading: 'Nová správa od obstarávateľa',
    intro: `${strong(esc(res.locals.user.company || res.locals.user.email))} vám poslal správu k obstarávaniu ${strong(esc(obst.nazov))}:`,
    bodyHtml: itemCard({ url: `${baseUrlOf(req)}/obstaravanie/${rows[0].token}?tab=komunikacia`, title: esc(text.slice(0, 200)), subtitle: '' }),
    link: `${baseUrlOf(req)}/obstaravanie/${rows[0].token}?tab=komunikacia`,
    linkLabel: 'Odpovedať v portáli',
  });
  res.redirect(`/ucet/obstaravania/${obst.id}?tab=komunikacia`);
});

// ─── Záverečná správa (PDF) a kompletný export (ZIP) ───

router.get('/:id/report.pdf', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="zaverecna-sprava-obstaravanie-${obst.id}.pdf"`);
  try {
    await buildFullPdf(obst.id, res);
  } catch (e) {
    console.error('[obst-report]', obst.id, e.message);
    if (!res.headersSent) return next(e);
    res.end();
  }
});

router.get('/:id/export.zip', async (req, res, next) => {
  const obst = await loadOwn(req);
  if (!obst) return next();
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="obstaravanie-${obst.id}-export.zip"`);
  try {
    await buildZip(obst.id, res);
  } catch (e) {
    console.error('[obst-export]', obst.id, e.message);
    if (!res.headersSent) return next(e);
    res.end();
  }
});

// ═══════════════════════════════════════════════════════════════
// DODÁVATEĽSKÝ PORTÁL (token-based, bez prihlásenia)
// ═══════════════════════════════════════════════════════════════

async function loadByToken(token) {
  const { rows } = await pool.query(
    `SELECT d.*, o.nazov AS obst_nazov, o.popis AS obst_popis, o.rozpocet,
            o.termin_ponuky, o.stav AS obst_stav, o.user_id,
            u.email AS obst_email, u.company AS obst_company
     FROM obstaravanie_dodavatelia d
     JOIN obstaravania o ON o.id = d.obstaravanie_id
     JOIN users u ON u.id = o.user_id
     WHERE d.token = $1 AND d.stav <> 'vyradeny'`, [token]);
  return rows[0] || null;
}

// Dodávateľ: hlavná stránka
portal.get('/:token', async (req, res, next) => {
  const d = await loadByToken(req.params.token);
  if (!d) return next();
  const [kola, podklady, ponuky, spravy] = await Promise.all([
    pool.query('SELECT * FROM obstaravanie_kola WHERE obstaravanie_id=$1 ORDER BY cislo', [d.obstaravanie_id]),
    pool.query(`SELECT p.*, s.nazov AS subor_nazov, s.mime, s.velkost
                FROM obstaravanie_podklady p JOIN subory s ON s.id = p.subor_id
                WHERE p.obstaravanie_id = $1 ORDER BY p.id`, [d.obstaravanie_id]),
    pool.query(`SELECT p.*, k.cislo AS kolo_cislo FROM obstaravanie_ponuky p
                JOIN obstaravanie_kola k ON k.id = p.kolo_id
                WHERE p.dodavatel_id = $1 ORDER BY k.cislo`, [d.id]),
    pool.query('SELECT * FROM obstaravanie_spravy WHERE dodavatel_id=$1 ORDER BY created_at', [d.id]),
  ]);
  const otvoreneKolo = kola.rows.find((k) => k.stav === 'otvorene') || null;
  res.render('portal-obstaravanie', {
    title: d.obst_nazov, d, kola: kola.rows, podklady: podklady.rows,
    ponuky: ponuky.rows, spravy: spravy.rows, otvoreneKolo, KATEGORIE,
  });
});

// Dodávateľ: stiahnuť podklad
portal.get('/:token/subor/:sid', async (req, res, next) => {
  const d = await loadByToken(req.params.token);
  if (!d) return next();
  const { rows } = await pool.query(
    `SELECT s.* FROM subory s JOIN obstaravanie_podklady p ON p.subor_id = s.id
     WHERE s.id = $1 AND p.obstaravanie_id = $2`, [req.params.sid, d.obstaravanie_id]);
  if (!rows.length) return next();
  const s = rows[0];
  res.set('Content-Type', s.mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(s.nazov)}"`);
  res.send(s.data);
});

// Dodávateľ: podať ponuku
portal.post('/:token/ponuka', portalLimit(20, 15 * 60 * 1000), upload.array('subory'), async (req, res, next) => {
  const d = await loadByToken(req.params.token);
  if (!d) return next();
  // Nájdi otvorené kolo
  const { rows: kola } = await pool.query(
    `SELECT * FROM obstaravanie_kola WHERE obstaravanie_id=$1 AND stav='otvorene' ORDER BY cislo DESC LIMIT 1`, [d.obstaravanie_id]);
  if (!kola.length) return res.redirect(`/obstaravanie/${req.params.token}?err=kolo_uzavrete`);
  const kolo = kola[0];
  const suma = req.body.suma ? Number(String(req.body.suma).replace(/\s/g, '').replace(',', '.')) || null : null;
  const poznamka = String(req.body.poznamka || '').trim().slice(0, 4000);
  // UPSERT ponuky — atomicky len do stále otvoreného kola (kolo sa mohlo medzitým uzavrieť)
  const { rows: ins } = await pool.query(
    `INSERT INTO obstaravanie_ponuky (kolo_id, dodavatel_id, suma, poznamka)
     SELECT k.id, $2, $3, $4 FROM obstaravanie_kola k WHERE k.id = $1 AND k.stav = 'otvorene'
     ON CONFLICT (kolo_id, dodavatel_id)
     DO UPDATE SET suma = EXCLUDED.suma, poznamka = EXCLUDED.poznamka, created_at = now()
     RETURNING id`,
    [kolo.id, d.id, suma, poznamka]);
  if (!ins.length) return res.redirect(`/obstaravanie/${req.params.token}?err=kolo_uzavrete`);
  const ponukaId = ins[0].id;
  // Prílohy k ponuke — nové odoslanie nahrádza predchádzajúce prílohy
  // (inak by sa pri každom prepise ponuky hromadili megabajty v DB)
  if ((req.files || []).length) {
    await pool.query(
      `DELETE FROM subory WHERE id IN (SELECT subor_id FROM obstaravanie_ponuka_subory WHERE ponuka_id = $1)`, [ponukaId]);
    await pool.query('DELETE FROM obstaravanie_ponuka_subory WHERE ponuka_id = $1', [ponukaId]);
  }
  for (const f of (req.files || [])) {
    const { rows: sr } = await pool.query(
      'INSERT INTO subory (nazov, mime, velkost, data) VALUES ($1,$2,$3,$4) RETURNING id',
      [f.originalname, f.mimetype, f.size, f.buffer]);
    await pool.query('INSERT INTO obstaravanie_ponuka_subory (ponuka_id, subor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ponukaId, sr[0].id]);
  }
  // Notifikuj obstarávateľa o novej/aktualizovanej ponuke
  notify({
    to: d.obst_email,
    subject: `Nová ponuka: ${d.obst_nazov}`,
    heading: 'Doručená nová ponuka',
    intro: `Dodávateľ ${strong(esc(d.nazov || d.email))} predložil ponuku v ${kolo.cislo}. kole obstarávania ${strong(esc(d.obst_nazov))}.`,
    bodyHtml: itemCard({
      url: `${baseUrlOf(req)}/ucet/obstaravania/${d.obstaravanie_id}?tab=ponuky`,
      title: suma != null ? `${Number(suma).toLocaleString('sk-SK')} € bez DPH` : 'Suma neuvedená',
      subtitle: [poznamka ? esc(poznamka.slice(0, 160)) : '', (req.files || []).length ? `${(req.files || []).length} príloh` : ''].filter(Boolean).join(' · '),
    }),
    link: `${baseUrlOf(req)}/ucet/obstaravania/${d.obstaravanie_id}?tab=ponuky`,
    linkLabel: 'Zobraziť ponuky',
    reason: 'Tento e-mail ste dostali ako obstarávateľ v systéme GrantHub.',
  });
  res.redirect(`/obstaravanie/${req.params.token}?ok=ponuka`);
});

// Dodávateľ: správa
portal.post('/:token/sprava', portalLimit(30, 15 * 60 * 1000), async (req, res, next) => {
  const d = await loadByToken(req.params.token);
  if (!d) return next();
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (text) {
    await pool.query('INSERT INTO obstaravanie_spravy (dodavatel_id, smer, text) VALUES ($1,$2,$3)', [d.id, 'dodavatel', text]);
    // Notifikuj obstarávateľa o novej správe
    notify({
      to: d.obst_email,
      subject: `Nová správa k obstarávaniu: ${d.obst_nazov}`,
      heading: 'Nová správa od dodávateľa',
      intro: `${strong(esc(d.nazov || d.email))} vám poslal správu k obstarávaniu ${strong(esc(d.obst_nazov))}:`,
      bodyHtml: itemCard({ url: `${baseUrlOf(req)}/ucet/obstaravania/${d.obstaravanie_id}?tab=komunikacia`, title: esc(text.slice(0, 200)), subtitle: '' }),
      link: `${baseUrlOf(req)}/ucet/obstaravania/${d.obstaravanie_id}?tab=komunikacia`,
      linkLabel: 'Odpovedať',
      reason: 'Tento e-mail ste dostali ako obstarávateľ v systéme GrantHub.',
    });
  }
  res.redirect(`/obstaravanie/${req.params.token}?tab=komunikacia`);
});

module.exports = { router, portal };
