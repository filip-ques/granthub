// Záverečná správa z obstarávania — PDF report (pdfkit) a ZIP export s prílohami.
// Report má štruktúru vhodnú na doloženie priebehu obstarávania (úrad, audit,
// poskytovateľ grantu): identifikácia, predmet, podklady, oslovení dodávatelia,
// priebeh po kolách s ponukami, výsledok a kompletná komunikácia.

const path = require('path');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { pool } = require('./db');

const FONT = path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf');

const BLUE = '#004494';
const INK = '#1a1a1a';
const MUTED = '#707070';
const LINE = '#d5d5d5';

const fmtDT = (d) => (d ? new Date(d).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtD = (d) => (d ? new Date(d).toLocaleDateString('sk-SK') : '—');
const fmtEur = (n) => (n == null ? '—' : Number(n).toLocaleString('sk-SK', { maximumFractionDigits: 2 }) + ' €');

const STAV_OBST = { priprava: 'Príprava', prebieha: 'Prebieha', vyhodnotenie: 'Vyhodnotenie', ukoncene: 'Ukončené', zrusene: 'Zrušené' };
const STAV_DOD = { pozvany: 'Pozvaný (neoslovený)', osloveny: 'Oslovený', vybrany: 'Víťaz', vyradeny: 'Vyradený' };
const STAV_PON = { dorucena: 'Doručená', ok: 'Akceptovaná', vyradena: 'Zrušená' };
const KATEGORIE = { projekt: 'Projektová dokumentácia', vv: 'Výkaz výmer', zmluva: 'Zmluva / dodatok', ine: 'Iné' };

// Načíta všetky dáta reportu pre obstarávanie
async function reportData(obstId) {
  const [obstQ, userQ, kolaQ, dodQ, podkladyQ, ponukyQ, spravyQ, prilohyQ] = await Promise.all([
    pool.query('SELECT * FROM obstaravania WHERE id = $1', [obstId]),
    pool.query('SELECT u.* FROM users u JOIN obstaravania o ON o.user_id = u.id WHERE o.id = $1', [obstId]),
    pool.query('SELECT * FROM obstaravanie_kola WHERE obstaravanie_id = $1 ORDER BY cislo', [obstId]),
    pool.query('SELECT * FROM obstaravanie_dodavatelia WHERE obstaravanie_id = $1 ORDER BY created_at', [obstId]),
    pool.query(`SELECT p.*, s.nazov AS subor_nazov, s.mime, s.velkost FROM obstaravanie_podklady p
                JOIN subory s ON s.id = p.subor_id WHERE p.obstaravanie_id = $1 ORDER BY p.id`, [obstId]),
    pool.query(`SELECT p.*, k.cislo AS kolo_cislo, d.email AS dod_email, d.nazov AS dod_nazov, d.id AS dod_id
                FROM obstaravanie_ponuky p
                JOIN obstaravanie_kola k ON k.id = p.kolo_id
                JOIN obstaravanie_dodavatelia d ON d.id = p.dodavatel_id
                WHERE k.obstaravanie_id = $1 ORDER BY k.cislo, p.suma NULLS LAST`, [obstId]),
    pool.query(`SELECT sp.*, d.email AS dod_email, d.nazov AS dod_nazov, d.id AS dod_id
                FROM obstaravanie_spravy sp JOIN obstaravanie_dodavatelia d ON d.id = sp.dodavatel_id
                WHERE d.obstaravanie_id = $1 ORDER BY sp.created_at LIMIT 500`, [obstId]),
    pool.query(`SELECT ps.ponuka_id, s.id AS subor_id, s.nazov, s.velkost
                FROM obstaravanie_ponuka_subory ps
                JOIN subory s ON s.id = ps.subor_id
                JOIN obstaravanie_ponuky po ON po.id = ps.ponuka_id
                JOIN obstaravanie_kola k ON k.id = po.kolo_id
                WHERE k.obstaravanie_id = $1 ORDER BY s.id`, [obstId]),
  ]);
  return {
    obst: obstQ.rows[0], user: userQ.rows[0], kola: kolaQ.rows, dodavatelia: dodQ.rows,
    podklady: podkladyQ.rows, ponuky: ponukyQ.rows, spravy: spravyQ.rows, prilohy: prilohyQ.rows,
  };
}

// ─── PDF ───

function h2(doc, text) {
  if (doc.y > 730) doc.addPage();
  doc.moveDown(0.8);
  doc.font(FONT_BOLD).fontSize(12).fillColor(BLUE).text(text);
  doc.moveTo(doc.page.margins.left, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor(BLUE).lineWidth(1).stroke();
  doc.moveDown(0.5);
  doc.font(FONT).fontSize(9.5).fillColor(INK);
}

function kv(doc, label, value) {
  const x = doc.page.margins.left;
  doc.font(FONT_BOLD).fontSize(9.5).fillColor(MUTED).text(label, x, doc.y, { continued: false, width: 160 });
  doc.moveUp();
  doc.font(FONT).fillColor(INK).text(String(value ?? '—'), x + 165, doc.y, { width: doc.page.width - doc.page.margins.right - x - 165 });
  doc.x = x;
  doc.moveDown(0.15);
}

// Jednoduchá tabuľka: cols = [{label, width}], rows = pole polí hodnôt
function table(doc, cols, rows) {
  const x0 = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  const scale = usable / totalW;
  const widths = cols.map((c) => Math.floor(c.width * scale));

  const drawRow = (vals, bold, bg) => {
    const heights = vals.map((v, i) =>
      doc.font(bold ? FONT_BOLD : FONT).fontSize(8.5).heightOfString(String(v ?? ''), { width: widths[i] - 8 }));
    const rh = Math.max(...heights, 12) + 8;
    if (doc.y + rh > 780) { doc.addPage(); }
    const y0 = doc.y;
    if (bg) doc.rect(x0, y0, usable, rh).fill('#eef2f8');
    let x = x0;
    vals.forEach((v, i) => {
      doc.font(bold ? FONT_BOLD : FONT).fontSize(8.5).fillColor(bold ? BLUE : INK)
        .text(String(v ?? ''), x + 4, y0 + 4, { width: widths[i] - 8 });
      x += widths[i];
    });
    doc.moveTo(x0, y0 + rh).lineTo(x0 + usable, y0 + rh).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.x = x0;
    doc.y = y0 + rh;
  };

  drawRow(cols.map((c) => c.label), true, true);
  rows.forEach((r) => drawRow(r, false, false));
  doc.moveDown(0.4);
}

async function buildPdf(obstId, res) {
  const d = await reportData(obstId);
  const { obst, user } = d;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 64, left: 50, right: 50 }, bufferPages: true, info: { Title: `Záverečná správa — ${obst.nazov}`, Author: 'GrantHub / ' + (user.company || user.email) } });
  doc.pipe(res);

  // Hlavička
  doc.rect(0, 0, doc.page.width, 6).fill(BLUE);
  doc.font(FONT_BOLD).fontSize(18).fillColor(INK).text('Záverečná správa z obstarávania', 50, 40);
  doc.font(FONT).fontSize(10).fillColor(MUTED).text(obst.nazov, { width: doc.page.width - 100 });
  doc.moveDown(0.6);

  // 1. Identifikácia
  h2(doc, '1. Identifikácia obstarávateľa');
  kv(doc, 'Obstarávateľ', user.company || user.name || user.email);
  if (user.ico) kv(doc, 'IČO', user.ico);
  kv(doc, 'Kontakt', user.email);
  kv(doc, 'Systém obstarávania', 'GrantHub — portál granthub.sk (Ayerf s. r. o., IČO 50991175)');

  // 2. Predmet
  h2(doc, '2. Predmet a priebeh obstarávania');
  kv(doc, 'Názov zákazky', obst.nazov);
  if (obst.popis) kv(doc, 'Opis predmetu', obst.popis);
  kv(doc, 'Predpokladaná hodnota', obst.rozpocet ? fmtEur(obst.rozpocet) + ' bez DPH' : 'neurčená');
  kv(doc, 'Vyhlásené (vytvorené)', fmtDT(obst.created_at));
  kv(doc, 'Termín na predloženie ponúk', fmtDT(obst.termin_ponuky));
  kv(doc, 'Stav', STAV_OBST[obst.stav] || obst.stav);
  kv(doc, 'Posledná zmena', fmtDT(obst.updated_at));
  kv(doc, 'Počet kôl', d.kola.length);
  kv(doc, 'Oslovených dodávateľov', d.dodavatelia.filter((x) => x.stav !== 'pozvany').length);
  kv(doc, 'Doručených ponúk', d.ponuky.length);

  // 3. Podklady
  h2(doc, '3. Súťažné podklady');
  if (!d.podklady.length) doc.text('Bez nahratých podkladov.');
  else table(doc,
    [{ label: 'Súbor', width: 46 }, { label: 'Kategória', width: 24 }, { label: 'Veľkosť', width: 12 }, { label: 'Popis', width: 18 }],
    d.podklady.map((p) => [p.subor_nazov, KATEGORIE[p.kategoria] || p.kategoria,
      p.velkost < 1024 ? `${p.velkost} B` : `${(p.velkost / 1024).toFixed(0)} kB`, p.popis || '']));

  // 4. Dodávatelia
  h2(doc, '4. Oslovení dodávatelia');
  if (!d.dodavatelia.length) doc.text('Žiadni dodávatelia.');
  else table(doc,
    [{ label: 'E-mail', width: 34 }, { label: 'Názov', width: 28 }, { label: 'Stav', width: 20 }, { label: 'Pridaný', width: 18 }],
    d.dodavatelia.map((x) => [x.email, x.nazov || '—', STAV_DOD[x.stav] || x.stav, fmtD(x.created_at)]));

  // 5. Kolá a ponuky
  h2(doc, '5. Priebeh po kolách a doručené ponuky');
  const prilohyByPonuka = {};
  d.prilohy.forEach((s) => { (prilohyByPonuka[s.ponuka_id] = prilohyByPonuka[s.ponuka_id] || []).push(s.nazov); });
  for (const kolo of d.kola) {
    doc.font(FONT_BOLD).fontSize(10).fillColor(INK)
      .text(`${kolo.cislo}. kolo — ${kolo.stav === 'otvorene' ? 'otvorené' : 'uzavreté'}${kolo.termin ? `, termín ${fmtDT(kolo.termin)}` : ''}`);
    doc.moveDown(0.25);
    const kp = d.ponuky.filter((p) => p.kolo_cislo === kolo.cislo);
    if (!kp.length) { doc.font(FONT).fontSize(9).fillColor(MUTED).text('V tomto kole neboli doručené žiadne ponuky.'); doc.moveDown(0.4); continue; }
    const minSuma = Math.min(...kp.filter((p) => p.suma != null).map((p) => Number(p.suma)));
    table(doc,
      [{ label: 'Dodávateľ', width: 26 }, { label: 'Suma (bez DPH)', width: 16 }, { label: 'Stav', width: 13 }, { label: 'Doručená', width: 15 }, { label: 'Poznámka / prílohy', width: 30 }],
      kp.map((p) => [
        (p.dod_nazov || p.dod_email) + (Number(p.suma) === minSuma ? '  ◂ najnižšia' : ''),
        fmtEur(p.suma), STAV_PON[p.stav] || p.stav, fmtDT(p.created_at),
        [p.poznamka, (prilohyByPonuka[p.id] || []).length ? `Prílohy: ${(prilohyByPonuka[p.id]).join(', ')}` : ''].filter(Boolean).join(' · '),
      ]));
  }

  // 6. Výsledok
  h2(doc, '6. Výsledok obstarávania');
  const vitaz = d.dodavatelia.find((x) => x.stav === 'vybrany');
  if (obst.stav === 'zrusene') {
    doc.text('Obstarávanie bolo zrušené obstarávateľom.');
  } else if (vitaz) {
    const vitazPonuky = d.ponuky.filter((p) => p.dod_id === vitaz.id && p.suma != null);
    const finalna = vitazPonuky.length ? vitazPonuky[vitazPonuky.length - 1] : null;
    kv(doc, 'Úspešný dodávateľ', vitaz.nazov || vitaz.email);
    kv(doc, 'Kontakt', vitaz.email);
    if (finalna) kv(doc, 'Víťazná ponuka', `${fmtEur(finalna.suma)} bez DPH (${finalna.kolo_cislo}. kolo)`);
    if (obst.rozpocet && finalna && finalna.suma != null) {
      const uspora = Number(obst.rozpocet) - Number(finalna.suma);
      if (uspora > 0) kv(doc, 'Úspora oproti PHZ', `${fmtEur(uspora)} (${(uspora / Number(obst.rozpocet) * 100).toFixed(1)} %)`);
    }
  } else {
    doc.text(obst.stav === 'ukoncene' ? 'Obstarávanie bolo ukončené bez výberu víťaza.' : 'Obstarávanie zatiaľ nebolo ukončené — správa zachytáva priebežný stav.');
  }

  // 7. Komunikácia
  h2(doc, '7. Záznam komunikácie s dodávateľmi');
  if (!d.spravy.length) doc.text('Bez zaznamenanej komunikácie.');
  else {
    const byDod = {};
    d.spravy.forEach((s) => { (byDod[s.dod_id] = byDod[s.dod_id] || []).push(s); });
    for (const [dodId, msgs] of Object.entries(byDod)) {
      const dod = d.dodavatelia.find((x) => String(x.id) === String(dodId));
      doc.font(FONT_BOLD).fontSize(9.5).fillColor(INK).text(dod ? (dod.nazov || dod.email) : `Dodávateľ #${dodId}`);
      doc.moveDown(0.2);
      table(doc,
        [{ label: 'Čas', width: 16 }, { label: 'Odosielateľ', width: 16 }, { label: 'Správa', width: 68 }],
        msgs.map((s) => [fmtDT(s.created_at), s.smer === 'obstaravatel' ? 'Obstarávateľ' : 'Dodávateľ', s.text]));
    }
  }

  // Pätičky so stránkovaním (bottom margin dočasne 0, inak text pretečie
  // spodný okraj a pdfkit pridá prázdne stránky)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(
      `Vygenerované systémom GrantHub (granthub.sk) dňa ${fmtDT(new Date())} · Táto správa dokumentuje priebeh obstarávania mimo režimu zákona č. 343/2015 Z. z. · Strana ${i + 1} z ${range.count}`,
      50, doc.page.height - 42, { width: doc.page.width - 100, align: 'center', height: 30 });
    doc.page.margins.bottom = oldBottom;
  }
  doc.end();
  return d;
}

// ─── ZIP export: report.pdf + podklady + prílohy ponúk ───

const safeName = (s) => String(s || 'subor').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

async function buildZip(obstId, res) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (e) => console.error('[zip-warn]', e.message));
  archive.pipe(res);
  // Po každom append počkáme na spracovanie entry — v pamäti je tak vždy len
  // jeden súbor namiesto celého exportu naraz (BYTEA súbory môžu mať stovky MB)
  const appended = (buf, name) => {
    const done = new Promise((resolve) => archive.once('entry', resolve));
    archive.append(buf, { name });
    return done;
  };

  // 1) PDF report (vygeneruj do bufferu cez PassThrough); buildPdf vracia dáta —
  // jeden snapshot pre PDF aj obsah ZIPu (konzistentný auditný export)
  const { PassThrough } = require('stream');
  const pdfStream = new PassThrough();
  const chunks = [];
  pdfStream.on('data', (c) => chunks.push(c));
  const pdfDone = new Promise((resolve) => pdfStream.on('end', resolve));
  const d = await buildPdf(obstId, pdfStream);
  await pdfDone;
  await appended(Buffer.concat(chunks), 'zaverecna-sprava.pdf');

  // 2) Podklady
  for (const p of d.podklady) {
    if (res.destroyed) return; // klient sa odpojil — nečítaj ďalšie súbory z DB
    const { rows } = await pool.query('SELECT data FROM subory WHERE id = $1', [p.subor_id]);
    if (rows.length) await appended(rows[0].data, `podklady/${safeName(p.subor_nazov)}`);
  }

  // 3) Prílohy ponúk: ponuky/kolo-N/<dodávateľ>/<súbor>
  const ponukaMeta = {};
  d.ponuky.forEach((p) => { ponukaMeta[p.id] = p; });
  for (const s of d.prilohy) {
    if (res.destroyed) return;
    const p = ponukaMeta[s.ponuka_id];
    if (!p) continue;
    const { rows } = await pool.query('SELECT data FROM subory WHERE id = $1', [s.subor_id]);
    if (rows.length) {
      await appended(rows[0].data, `ponuky/kolo-${p.kolo_cislo}/${safeName(p.dod_nazov || p.dod_email)}/${safeName(s.nazov)}`);
    }
  }

  await archive.finalize();
}

module.exports = { buildPdf, buildZip, reportData };
