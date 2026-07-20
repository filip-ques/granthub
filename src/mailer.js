// E-maily: SMTP keď je nakonfigurované, inak výpis do konzoly.
// Všetky e-maily zdieľajú jeden responzívny HTML obal s hlavičkou GrantHub
// a právne korektnou pätičkou (prevádzkovateľ, dôvod doručenia, odhlásenie).

const nodemailer = require('nodemailer');

const BLUE = '#004494';
const INK = '#1a1a1a';
const TEXT = '#404040';
const MUTED = '#707070';
const LINE = '#d5d5d5';
const BG = '#f5f6f7';

const LEGAL = 'Ayerf s. r. o. · IČO 50991175 · Ľubovnianska 12, 851 07 Bratislava-Petržalka';

const smtpConfigured = !!process.env.SMTP_HOST;

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

const baseUrl = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// Zdieľaný obal — všetky e-maily vyzerajú konzistentne s webom
function shell({ preheader, heading, introHtml, bodyHtml = '', reason = '', unsub = '' }) {
  const base = baseUrl();
  const year = new Date().getFullYear();
  let links = `<a href="${base}/ochrana-osobnych-udajov" style="color:${MUTED};text-decoration:underline">Ochrana osobných údajov</a>` +
    ` &nbsp;·&nbsp; <a href="${base}/obchodne-podmienky" style="color:${MUTED};text-decoration:underline">Obchodné podmienky</a>`;
  if (unsub) {
    links += ` &nbsp;·&nbsp; <a href="${base}/grantovy-radar" style="color:${MUTED};text-decoration:underline">Nastavenia radaru</a>` +
             ` &nbsp;·&nbsp; <a href="${unsub}" style="color:${MUTED};text-decoration:underline">Odhlásiť odber</a>`;
  }
  const reasonHtml = reason ? `<p style="margin:0 0 10px;color:${MUTED};font-size:12px">${reason}</p>` : '';

  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:${BG};font-family:Arial,Helvetica,sans-serif;color:${TEXT}">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0"
             style="width:600px;max-width:100%;background:#fff;border:1px solid ${LINE};border-radius:10px;overflow:hidden">
        <tr><td style="background:${BLUE};padding:20px 28px">
          <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-.01em">Grant<span style="color:#ffd617">Hub</span></span>
        </td></tr>
        <tr><td style="padding:32px 28px">
          <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${INK}">${heading}</h1>
          ${introHtml}
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 28px;background:${BG};border-top:1px solid ${LINE}">
          ${reasonHtml}
          <p style="margin:0 0 10px;font-size:12px;color:${MUTED}">${links}</p>
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5">
            © ${year} GrantHub. Prevádzkovateľ: ${LEGAL}.<br>
            GrantHub je informačná služba a nie je oficiálnym portálom verejného obstarávania ani eurofondov.
          </p>
        </td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:11px;color:${MUTED}">Údaje pochádzajú z ITMS open data a európskeho vestníka TED.</p>
    </td></tr>
  </table>
</body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0">` +
    `<tr><td style="background:${BLUE};border-radius:6px">` +
    `<a href="${href}" style="display:inline-block;padding:14px 30px;color:#fff;font-weight:700;` +
    `font-size:15px;text-decoration:none">${label}</a></td></tr></table>`;
}

// Karta položky (výzva/zákazka) do digestu
function itemCard({ url, title, subtitle, facts }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="margin:0 0 12px;border:1px solid ${LINE};border-left:4px solid ${BLUE};border-radius:6px">` +
    `<tr><td style="padding:14px 16px">` +
    `<a href="${url}" style="color:${BLUE};font-weight:700;font-size:15px;text-decoration:none;line-height:1.4">${title}</a>` +
    `<div style="color:${MUTED};font-size:13px;margin-top:6px;line-height:1.6">` +
    `${subtitle}${facts ? `<br>${facts}` : ''}` +
    `</div></td></tr></table>`;
}

function sectionHeading(label) {
  return `<h2 style="margin:22px 0 12px;font-size:15px;color:${INK};text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid ${BLUE};padding-bottom:6px">${label}</h2>`;
}

const para = (t) => `<p style="margin:0 0 6px;font-size:15px;line-height:1.6">${t}</p>`;
const small = (t) => `<p style="margin:0 0 14px;font-size:13px;color:${MUTED}">${t}</p>`;
const strong = (t) => `<strong style="color:${INK}">${t}</strong>`;

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log('=== SMTP nie je nakonfigurované — e-mail sa neodoslal ===');
    console.log(`Komu: ${to}\nPredmet: ${subject}\n${text}`);
    console.log('========================================================');
    return { sent: false };
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: text || 'Táto správa vyžaduje HTML klienta.',
    html,
  });
  return { sent: true };
}

module.exports = { sendMail, smtpConfigured, shell, button, itemCard, sectionHeading, para, small, strong };
