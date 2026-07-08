// Pošle ukážku každého typu e-mailu na zadanú adresu (reálne šablóny, reálne dáta z DB).
// Spustenie: node --env-file=.env scripts/test-emails.js prijemca@example.com

const { pool } = require('../src/db');
const mail = require('../src/mailer');

const TO = process.argv[2] || 'filip@ques.sk';
const BASE = (process.env.BASE_URL || 'https://granthub.sk').replace(/\/$/, '');

(async () => {
  const { rows: vyzvy } = await pool.query(
    `SELECT * FROM vyzvy WHERE status='otvorena' AND deadline IS NOT NULL ORDER BY deadline LIMIT 2`);
  const { rows: tendre } = await pool.query(
    `SELECT * FROM tenders WHERE deadline >= now() ORDER BY deadline ASC LIMIT 2`);

  const fakeLink = `${BASE}/auth/overit?token=ukazkovy-test-token`;
  const sends = [];

  // 1. Prihlásenie (magic link)
  sends.push(['1/7 Prihlásenie do GrantHubu', mail.shell({
    preheader: 'Váš odkaz (platí 15 minút)',
    heading: 'Prihlásenie do GrantHubu',
    introHtml: mail.para('Dobrý deň, na prihlásenie kliknite na tlačidlo nižšie — bez hesla.'),
    bodyHtml: mail.button(fakeLink, 'Prihlásiť sa') +
      mail.small('Odkaz je platný <strong>15 minút</strong> a použije sa iba raz.') +
      mail.small('Ak ste o tento e-mail nežiadali, ignorujte ho.'),
  })]);

  // 2. Registrácia
  sends.push(['2/7 Dokončite registráciu v GrantHube', mail.shell({
    preheader: 'Dokončenie registrácie',
    heading: 'Vitajte! Dokončite registráciu',
    introHtml: mail.para('Dobrý deň, registráciu dokončíte kliknutím na tlačidlo — bez hesla.'),
    bodyHtml: mail.button(fakeLink, 'Dokončiť registráciu') +
      mail.small('Odkaz je platný <strong>15 minút</strong> a použije sa iba raz.'),
  })]);

  // 3. Potvrdenie odberu radaru
  sends.push(['3/7 Potvrďte odber radaru', mail.shell({
    preheader: 'Potvrdenie odberu radaru',
    heading: 'Potvrďte odber radaru',
    introHtml: mail.para('Dobrý deň, odber radaru potvrdíte kliknutím na tlačidlo (zároveň vás prihlási do účtu).'),
    bodyHtml: mail.button(fakeLink, 'Potvrdiť odber a prihlásiť sa') +
      mail.small('Ak ste o odber nežiadali, e-mail ignorujte — bez kliknutia sa nič nestane.'),
  })]);

  // 4. Radar digest (granty + tendre)
  let digest = mail.sectionHeading(`Granty (${vyzvy.length})`);
  for (const v of vyzvy) {
    digest += mail.itemCard({
      url: `${BASE}/vyzvy/${v.slug}`,
      title: v.title,
      subtitle: v.provider || v.category,
      facts: `${mail.strong(v.amount_max ? 'do ' + Number(v.amount_max).toLocaleString('sk-SK') + ' €' : (v.allocation ? 'alokácia ' + Number(v.allocation).toLocaleString('sk-SK') + ' €' : 'suma neurčená'))} &nbsp;·&nbsp; uzávierka ${new Date(v.deadline).toLocaleDateString('sk-SK')}`,
    });
  }
  digest += mail.sectionHeading(`Tendre (${tendre.length})`);
  for (const t of tendre) {
    digest += mail.itemCard({
      url: `${BASE}/tendre/${t.id}`,
      title: t.title,
      subtitle: t.buyer_name || 'Verejný obstarávateľ',
      facts: `${mail.strong(t.value_eur ? Number(t.value_eur).toLocaleString('sk-SK') + ' €' : 'hodnota neuvedená')} &nbsp;·&nbsp; lehota ${new Date(t.deadline).toLocaleDateString('sk-SK')}`,
    });
  }
  digest += mail.button(`${BASE}/vyzvy`, 'Zobraziť všetko v GrantHube');
  sends.push([`4/7 GrantHub: ${vyzvy.length + tendre.length} nové položky vo vašich oblastiach`, mail.shell({
    preheader: 'Novinky z vašich oblastí',
    heading: 'Nové výzvy a zákazky pre vás',
    introHtml: mail.para(`Dobrý deň, v GrantHube pribudli ${mail.strong(vyzvy.length + tendre.length)} novinky z oblastí, ktoré sledujete.`),
    bodyHtml: digest,
    reason: 'Tento súhrn dostávate, lebo ste si v GrantHube zapli radar.',
    unsub: `${BASE}/grantovy-radar`,
  })]);

  // 5. Strážcovia
  let watcher = mail.sectionHeading(`Strážca „IT zákazky Bratislava“ (${tendre.length})`);
  for (const t of tendre) {
    watcher += mail.itemCard({
      url: `${BASE}/tendre/${t.id}`,
      title: t.title,
      subtitle: t.buyer_name || 'Verejný obstarávateľ',
      facts: `lehota ${new Date(t.deadline).toLocaleDateString('sk-SK')}`,
    });
  }
  watcher += mail.button(`${BASE}/ucet/straznici`, 'Spravovať strážcov');
  sends.push([`5/7 GrantHub: ${tendre.length} nové tendre pre vašich strážcov`, mail.shell({
    preheader: 'Nové tendre pre strážcov',
    heading: 'Vaši strážcovia našli nové tendre',
    introHtml: mail.para(`Dobrý deň, uložené vyhľadávania našli ${mail.strong(tendre.length)} nových zákaziek.`),
    bodyHtml: watcher,
    reason: 'Tento e-mail dostávate, lebo máte v GrantHube uložených strážcov trhu.',
  })]);

  // 6. Potvrdenie objednávky (zákazník)
  sends.push(['6/7 Prijali sme vašu objednávku', mail.shell({
    preheader: 'Vaša objednávka je prijatá',
    heading: 'Objednávka prijatá',
    introHtml: mail.para(`Dobrý deň, Filip, prijali sme vašu nezáväznú objednávku služby ${mail.strong('Napasovanie firmy na konkrétnu výzvu')}.` + (vyzvy[0] ? `<br>Výzva: ${vyzvy[0].title}` : '')),
    bodyHtml: mail.small('Ozveme sa vám s ďalším postupom. Objednávka je nezáväzná — rozsah a konečnú cenu potvrdíme vopred.') +
      mail.button(`${BASE}/ucet`, 'Prehľad objednávok v účte'),
    reason: 'Tento e-mail ste dostali ako potvrdenie objednávky odoslanej na GrantHube.',
  })]);

  // 7. Notifikácia objednávky (pre admina)
  sends.push(['7/7 Objednávka: Vypracovanie projektu a žiadosti o grant', mail.shell({
    preheader: 'Objednávka od Filip Test',
    heading: 'Nová objednávka: Vypracovanie projektu a žiadosti o grant',
    introHtml: mail.para(vyzvy[0] ? `Výzva: ${vyzvy[0].title}` : 'Bez naviazania na výzvu.'),
    bodyHtml: mail.itemCard({
      url: `mailto:${TO}`,
      title: `Filip Test <${TO}>`,
      subtitle: 'Ayerf s. r. o. (IČO 50991175) · +421 900 000 000',
      facts: 'Ukážková správa zákazníka: máme záujem o prípravu žiadosti, ozvite sa prosím.',
    }),
  })]);

  for (const [subject, html] of sends) {
    await mail.sendMail({ to: TO, subject: `[TEST] ${subject}`, text: 'Testovací e-mail GrantHub — HTML verzia v e-mailovom klientovi.', html });
    console.log('odoslané:', subject);
  }
  await pool.end();
})();
