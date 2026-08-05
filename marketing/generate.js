// Generátor marketingových materiálov GrantHub (one-pager A4 + prezentácia 16:9).
// Spustenie: node marketing/generate.js [cesta-k-screenshotom]
// Screenshoty (home.png, vyzvy.png, tendre.png, radar.png) sú voliteľné — bez nich
// sa slajdy so zábermi preskočia. Čísla (výzvy/tendre) sa zadávajú nižšie ručne
// z produkcie, s dátumom, ku ktorému platia.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const SHOTS = process.argv[2] || __dirname;
const OUT = __dirname;
const FONT = path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf');

// Overené čísla z produkcie
const STAT_DATE = '5. 8. 2026';
const N_VYZVY = '447';
const N_TENDRE = '1 607';

const BLUE = '#004494';
const BLUE_DARK = '#00306a';
const YELLOW = '#ffd617';
const INK = '#1a1a1a';
const MUTED = '#6a6a6a';
const LINE = '#d9d9d9';
const TINT = '#eef2f8';

const has = (f) => fs.existsSync(path.join(SHOTS, f));
const shot = (f) => path.join(SHOTS, f);

// ─── pomôcky ───

function wordmark(doc, x, y, size, onDark) {
  doc.font(FONT_BOLD).fontSize(size);
  doc.fillColor(onDark ? '#ffffff' : INK).text('Grant', x, y, { continued: true });
  doc.fillColor(onDark ? YELLOW : BLUE).text('Hub');
}

// ═══════════════════════════════════════════════════════════
// 1) ONE-PAGER (A4 na výšku)
// ═══════════════════════════════════════════════════════════

function onepager() {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: 'GrantHub — produktový list', Author: 'Ayerf s. r. o.' } });
  doc.pipe(fs.createWriteStream(path.join(OUT, 'granthub-onepager.pdf')));
  const W = doc.page.width;   // 595
  const M = 46;               // okraj
  const CW = W - 2 * M;       // šírka obsahu

  // Hlavička
  doc.rect(0, 0, W, 118).fill(BLUE);
  doc.rect(0, 118, W, 5).fill(YELLOW);
  wordmark(doc, M, 34, 30, true);
  doc.font(FONT).fontSize(12.5).fillColor('#dbe6f5')
    .text('Granty, dotácie a verejné zákazky na jednom mieste', M, 74);

  // Intro
  doc.font(FONT).fontSize(10.5).fillColor(INK).text(
    'GrantHub denne sleduje grantové výzvy z eurofondov (ITMS2014+, Program Slovensko), Plánu obnovy a ďalších zdrojov a verejné zákazky z európskeho vestníka TED. Celá databáza aj e-mailové notifikácie sú zadarmo — platíte len vtedy, keď potrebujete pomoc so žiadosťou alebo ponukou.',
    M, 148, { width: CW, lineGap: 2.5 });

  // Čísla
  const statY = 212;
  const stats = [
    [N_VYZVY, 'otvorených grantových výziev'],
    [N_TENDRE, 'aktuálnych verejných zákazok'],
    ['0 €', 'databáza aj radar zadarmo'],
  ];
  const bw = (CW - 24) / 3;
  stats.forEach(([num, label], i) => {
    const x = M + i * (bw + 12);
    doc.rect(x, statY, bw, 74).fill(TINT);
    doc.rect(x, statY, bw, 3).fill(BLUE);
    doc.font(FONT_BOLD).fontSize(23).fillColor(BLUE).text(num, x, statY + 14, { width: bw, align: 'center' });
    doc.font(FONT).fontSize(8.5).fillColor(MUTED).text(label, x + 8, statY + 46, { width: bw - 16, align: 'center' });
  });
  doc.font(FONT).fontSize(7).fillColor(MUTED).text(`Stav k ${STAT_DATE}. Údaje sa aktualizujú niekoľkokrát denne.`, M, statY + 82, { width: CW });

  // Funkcie
  let y = 322;
  doc.font(FONT_BOLD).fontSize(14).fillColor(BLUE).text('Čo v GrantHube nájdete — zadarmo', M, y);
  y += 24;
  const feats = [
    ['Katalóg výziev a tendrov', 'Filtrovanie podľa kategórií, žiadateľov, krajov a odvetví. Pri každej výzve termíny, podmienky a oficiálne odkazy.'],
    ['Grantový radar', 'E-mailové upozornenia na nové výzvy a tendre presne podľa vášho zamerania. Žiadny spam — len to, čo sedí vašej firme.'],
    ['Firemná zóna', 'Strážcovia tendrov, nástenka rozpracovaných zákaziek a profil firmy s verejnými údajmi podľa IČO (register, zmluvy, projekty).'],
    ['De minimis kalkulačka', 'Prehľad čerpanej pomoci de minimis a okamžitá kontrola, koľko limitu vašej firme ešte zostáva.'],
    ['Vlastné obstarávanie', 'Vytvorte mini-tender, pozvite dodávateľov e-mailom a zbierajte ponuky vo viacerých kolách — dodávatelia nepotrebujú registráciu.'],
    ['Záverečná správa pre úrad', 'Celý priebeh obstarávania na jedno kliknutie: PDF so všetkými ponukami, prílohami a komunikáciou — pripravené na doloženie.'],
  ];
  const colW = (CW - 20) / 2;
  feats.forEach(([t, txt], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = M + col * (colW + 20);
    const yy = y + row * 74;
    doc.rect(x, yy + 3, 3, 12).fill(YELLOW);
    doc.font(FONT_BOLD).fontSize(10.5).fillColor(INK).text(t, x + 10, yy);
    doc.font(FONT).fontSize(8.5).fillColor(MUTED).text(txt, x + 10, yy + 16, { width: colW - 10, lineGap: 1.5 });
  });

  // Cenník
  y = y + 3 * 74 + 14;
  doc.font(FONT_BOLD).fontSize(14).fillColor(BLUE).text('Keď potrebujete pomoc — služby so zľavou −50 % pri spustení', M, y);
  y += 24;
  const svc = [
    ['Napasovanie firmy na výzvu', '499 €', '998 €'],
    ['Vypracovanie projektu a žiadosti', '999 €', '1 998 €'],
    ['Overenie podmienok tendra', '249 €', '499 €'],
    ['Podanie na tender na kľúč', '499 €', '999 €'],
  ];
  const sw = (CW - 36) / 4;
  svc.forEach(([name, price, orig], i) => {
    const x = M + i * (sw + 12);
    doc.rect(x, y, sw, 86).lineWidth(1).stroke(LINE);
    doc.rect(x, y, sw, 3).fill(BLUE);
    doc.font(FONT).fontSize(8).fillColor(INK).text(name, x + 8, y + 10, { width: sw - 16, lineGap: 1 });
    doc.font(FONT).fontSize(8).fillColor(MUTED).text(orig, x + 8, y + 46, { width: sw - 16, strike: true });
    doc.font(FONT_BOLD).fontSize(14).fillColor(BLUE).text('od ' + price, x + 8, y + 58, { width: sw - 16 });
  });
  doc.font(FONT).fontSize(7).fillColor(MUTED).text('Ceny bez DPH. Monitoring a celá databáza zostávajú zadarmo bez ohľadu na služby.', M, y + 94, { width: CW });

  // Pätička
  doc.rect(0, 772, W, 70).fill(BLUE_DARK);
  wordmark(doc, M, 790, 16, true);
  doc.font(FONT).fontSize(9).fillColor('#dbe6f5')
    .text('granthub.sk  ·  info@granthub.sk', M, 814);
  doc.font(FONT).fontSize(7.5).fillColor('#9db4d4')
    .text('Ayerf s. r. o. · IČO 50991175 · Ľubovnianska 12, 851 07 Bratislava-Petržalka', W - M - 300, 795, { width: 300, align: 'right' });
  doc.font(FONT_BOLD).fontSize(9).fillColor(YELLOW)
    .text('Registrácia zadarmo na granthub.sk', W - M - 300, 812, { width: 300, align: 'right' });

  doc.end();
}

// ═══════════════════════════════════════════════════════════
// 2) PREZENTÁCIA (16:9)
// ═══════════════════════════════════════════════════════════

const SW = 960, SH = 540, SM = 64;

function deck() {
  const doc = new PDFDocument({ size: [SW, SH], margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: 'GrantHub — prezentácia', Author: 'Ayerf s. r. o.' } });
  doc.pipe(fs.createWriteStream(path.join(OUT, 'granthub-prezentacia.pdf')));

  const slideHead = (kicker, title) => {
    doc.rect(0, 0, SW, 6).fill(YELLOW);
    doc.font(FONT_BOLD).fontSize(11).fillColor(BLUE).text(kicker.toUpperCase(), SM, 40, { characterSpacing: 1 });
    doc.font(FONT_BOLD).fontSize(27).fillColor(INK).text(title, SM, 60, { width: SW - 2 * SM });
  };
  const foot = (n) => {
    doc.font(FONT).fontSize(8).fillColor(MUTED).text('granthub.sk', SM, SH - 30);
    doc.font(FONT).fontSize(8).fillColor(MUTED).text(String(n), SW - SM - 20, SH - 30, { width: 20, align: 'right' });
  };

  // 1 — obálka
  doc.rect(0, 0, SW, SH).fill(BLUE);
  doc.rect(0, SH - 10, SW, 10).fill(YELLOW);
  wordmark(doc, SM, 190, 58, true);
  doc.font(FONT).fontSize(19).fillColor('#dbe6f5')
    .text('Granty, dotácie a verejné zákazky na jednom mieste', SM, 275);
  doc.font(FONT).fontSize(12).fillColor('#9db4d4').text('granthub.sk · zadarmo pre firmy, obce aj neziskovky', SM, 310);

  // 2 — problém
  doc.addPage();
  slideHead('Problém', 'Peniaze existujú. Firmy ich nevidia.');
  const probs = [
    'Grantové výzvy sú roztrúsené po desiatkach webov — ITMS, Plán obnovy, ministerstvá, nadácie.',
    'Verejné zákazky vychádzajú denne v európskom vestníku TED — kto ich nesleduje, nesúťaží.',
    'Termíny výziev utekajú skôr, než sa k firme informácia vôbec dostane.',
    'Poradenské firmy si za samotný prehľad pýtajú stovky eur mesačne.',
  ];
  let py = 150;
  probs.forEach((p) => {
    doc.circle(SM + 5, py + 8, 4).fill(YELLOW);
    doc.font(FONT).fontSize(14.5).fillColor(INK).text(p, SM + 24, py, { width: SW - 2 * SM - 24, lineGap: 2 });
    py += 62;
  });
  foot(2);

  // 3 — riešenie s číslami
  doc.addPage();
  slideHead('Riešenie', 'Všetko na jednom mieste. Zadarmo.');
  const nums = [
    [N_VYZVY, 'otvorených grantových výziev', 'eurofondy, Program Slovensko, Plán obnovy a ďalšie'],
    [N_TENDRE, 'aktuálnych verejných zákazok', 'vestník TED — zákazky s miestom plnenia na Slovensku'],
    ['0 €', 'za databázu aj notifikácie', 'platí sa len za voliteľné služby na požiadanie'],
  ];
  const nw = (SW - 2 * SM - 48) / 3;
  nums.forEach(([n, l, s], i) => {
    const x = SM + i * (nw + 24);
    doc.rect(x, 160, nw, 190).fill(TINT);
    doc.rect(x, 160, nw, 5).fill(BLUE);
    doc.font(FONT_BOLD).fontSize(44).fillColor(BLUE).text(n, x, 195, { width: nw, align: 'center' });
    doc.font(FONT_BOLD).fontSize(12.5).fillColor(INK).text(l, x + 14, 258, { width: nw - 28, align: 'center' });
    doc.font(FONT).fontSize(9.5).fillColor(MUTED).text(s, x + 14, 296, { width: nw - 28, align: 'center', lineGap: 1.5 });
  });
  doc.font(FONT).fontSize(9).fillColor(MUTED).text(`Stav k ${STAT_DATE}. Databáza sa aktualizuje niekoľkokrát denne.`, SM, 380);
  foot(3);

  // 4 — screenshot home
  if (has('home.png')) {
    doc.addPage();
    slideHead('Produkt', 'Prehľadný katalóg s okamžitým vyhľadávaním');
    doc.save().rect(SM, 130, SW - 2 * SM, 350).clip();
    doc.image(shot('home.png'), SM, 130, { width: SW - 2 * SM });
    doc.restore();
    doc.rect(SM, 130, SW - 2 * SM, 350).lineWidth(1).stroke(LINE);
    foot(4);
  }

  // 5 — funkcie
  doc.addPage();
  slideHead('Funkcie', 'Od monitoringu po vlastné obstarávanie');
  const feats = [
    ['Grantový radar', 'e-mailové upozornenia presne podľa zamerania firmy'],
    ['Strážcovia tendrov', 'uložené vyhľadávania s automatickým digestom'],
    ['Pipeline zákaziek', 'nástenka rozpracovaných tendrov od záujmu po podanie'],
    ['Moja firma', 'verejné údaje podľa IČO — register, zmluvy, projekty'],
    ['De minimis kalkulačka', 'okamžitá kontrola zostávajúceho limitu pomoci'],
    ['AI prehľady výziev', 'zrozumiteľný rozpis podmienok z oficiálnych zdrojov'],
  ];
  const fw = (SW - 2 * SM - 48) / 3;
  feats.forEach(([t, s], i) => {
    const x = SM + (i % 3) * (fw + 24);
    const yy = 150 + Math.floor(i / 3) * 150;
    doc.rect(x, yy, fw, 126).lineWidth(1).stroke(LINE);
    doc.rect(x, yy, 5, 126).fill(BLUE);
    doc.font(FONT_BOLD).fontSize(14).fillColor(INK).text(t, x + 18, yy + 18, { width: fw - 32 });
    doc.font(FONT).fontSize(10.5).fillColor(MUTED).text(s, x + 18, yy + 46, { width: fw - 32, lineGap: 2 });
  });
  foot(5);

  // 6 — obstarávanie
  doc.addPage();
  slideHead('Novinka', 'Vlastné obstarávanie s portálom pre dodávateľov');
  const steps = [
    ['1', 'Vytvoríte obstarávanie', 'názov, podklady, termín — hotové za pár minút'],
    ['2', 'Pozvete dodávateľov', 'stačí e-mail; dodávateľ dostane odkaz a nepotrebuje registráciu'],
    ['3', 'Zbierate ponuky v kolách', 'porovnanie cien, komunikácia a výber víťaza na jednom mieste'],
    ['4', 'Stiahnete záverečnú správu', 'jedno PDF s celým priebehom, ponukami aj prílohami — pripravené pre úrad či poskytovateľa grantu'],
  ];
  let sy = 150;
  steps.forEach(([n, t, s]) => {
    doc.circle(SM + 16, sy + 16, 16).fill(BLUE);
    doc.font(FONT_BOLD).fontSize(15).fillColor('#fff').text(n, SM + 11, sy + 7, { width: 12, align: 'center' });
    doc.font(FONT_BOLD).fontSize(15).fillColor(INK).text(t, SM + 48, sy);
    doc.font(FONT).fontSize(11).fillColor(MUTED).text(s, SM + 48, sy + 21, { width: SW - 2 * SM - 60 });
    sy += 82;
  });
  foot(6);

  // 7 — screenshoty katalógov
  if (has('vyzvy.png') && has('tendre.png')) {
    doc.addPage();
    slideHead('Produkt', 'Výzvy aj tendre s filtrami na mieru');
    const iw = (SW - 2 * SM - 24) / 2;
    for (const [i, f] of [[0, 'vyzvy.png'], [1, 'tendre.png']]) {
      const x = SM + i * (iw + 24);
      doc.save().rect(x, 140, iw, 330).clip();
      doc.image(shot(f), x, 140, { width: iw });
      doc.restore();
      doc.rect(x, 140, iw, 330).lineWidth(1).stroke(LINE);
    }
    doc.font(FONT).fontSize(10).fillColor(MUTED).text('Katalóg grantových výziev', SM, 480, { width: iw, align: 'center' });
    doc.font(FONT).fontSize(10).fillColor(MUTED).text('Katalóg verejných zákaziek', SM + iw + 24, 480, { width: iw, align: 'center' });
  }

  // 8 — cenník
  doc.addPage();
  slideHead('Služby', 'Platíte, len keď potrebujete pomoc');
  const svc = [
    ['Napasovanie firmy na konkrétnu výzvu', 'oplatí sa žiadať? Odpoveď do 5 pracovných dní', '499 €', '998 €'],
    ['Vypracovanie projektu a žiadosti', 'kompletná žiadosť o grant na kľúč až po podanie', '999 €', '1 998 €'],
    ['Overenie splnenia podmienok tendra', 'analýza podkladov a odporúčanie ísť / neísť', '249 €', '499 €'],
    ['Vytvorenie podania na tender', 'kompletná ponuka do verejného obstarávania', '499 €', '999 €'],
  ];
  const pw = (SW - 2 * SM - 72) / 4;
  svc.forEach(([t, s, p, o], i) => {
    const x = SM + i * (pw + 24);
    doc.rect(x, 150, pw, 250).lineWidth(1).stroke(LINE);
    doc.rect(x, 150, pw, 5).fill(BLUE);
    doc.font(FONT_BOLD).fontSize(12.5).fillColor(INK).text(t, x + 14, 170, { width: pw - 28, lineGap: 1.5 });
    doc.font(FONT).fontSize(9.5).fillColor(MUTED).text(s, x + 14, 232, { width: pw - 28, lineGap: 1.5 });
    doc.font(FONT).fontSize(10).fillColor(MUTED).text(o, x + 14, 310, { strike: true });
    doc.font(FONT_BOLD).fontSize(19).fillColor(BLUE).text('od ' + p, x + 14, 326);
    doc.rect(x + 14, 358, 64, 18).fill(YELLOW);
    doc.font(FONT_BOLD).fontSize(9).fillColor(INK).text('−50 %', x + 14, 363, { width: 64, align: 'center' });
  });
  doc.font(FONT).fontSize(9).fillColor(MUTED).text('Ceny bez DPH. Zľava −50 % platí pri spustení portálu. Monitoring a databáza zostávajú zadarmo.', SM, 425);
  foot(8);

  // 9 — CTA
  doc.addPage();
  doc.rect(0, 0, SW, SH).fill(BLUE);
  doc.rect(0, SH - 10, SW, 10).fill(YELLOW);
  doc.font(FONT_BOLD).fontSize(34).fillColor('#fff').text('Vyskúšajte GrantHub ešte dnes', SM, 170, { width: SW - 2 * SM });
  doc.font(FONT).fontSize(15).fillColor('#dbe6f5')
    .text('Registrácia na minútu, bez platobnej karty. Nastavte si radar a nová výzva vám už neujde.', SM, 230, { width: SW - 2 * SM - 120, lineGap: 3 });
  doc.rect(SM, 300, 300, 52).fill(YELLOW);
  doc.font(FONT_BOLD).fontSize(18).fillColor(INK).text('granthub.sk', SM, 316, { width: 300, align: 'center' });
  doc.font(FONT).fontSize(11).fillColor('#9db4d4')
    .text('info@granthub.sk · Ayerf s. r. o., IČO 50991175, Bratislava', SM, 400);

  doc.end();
}

onepager();
deck();
console.log('Hotovo: granthub-onepager.pdf + granthub-prezentacia.pdf');
