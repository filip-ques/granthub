// Radar digest — pošle odberateľom e-mail o výzvach, ktoré pribudli od posledného behu.

const crypto = require('crypto');
const { pool } = require('./db');
const { foldText } = require('./tender-catalog');
const mail = require('./mailer');
const { sendMail } = mail;

function unsubToken(email) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-zmen-v-produkcii';
  return crypto.createHmac('sha256', secret).update(`radar:${email}`).digest('hex').slice(0, 32);
}

async function runRadar() {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  const { rows: stateRows } = await pool.query(
    `SELECT value FROM job_state WHERE key = 'radar_last_run'`
  );
  // Prvý beh: neposielaj historické výzvy, len si zapamätaj čas
  const lastRun = stateRows.length ? new Date(stateRows[0].value) : null;
  const now = new Date();

  let sent = 0;
  let newCount = 0;
  let newTenders = 0;

  if (lastRun) {
    const [{ rows: fresh }, { rows: freshTenders }] = await Promise.all([
      pool.query(
        `SELECT * FROM vyzvy WHERE created_at > $1 AND status = 'otvorena' ORDER BY created_at`, [lastRun]),
      pool.query(
        `SELECT * FROM tenders WHERE created_at > $1 AND (deadline IS NULL OR deadline >= now())
         ORDER BY created_at`, [lastRun]),
    ]);
    newCount = fresh.length;
    newTenders = freshTenders.length;

    if (fresh.length || freshTenders.length) {
      const { rows: subs } = await pool.query(`SELECT * FROM radar_subscriptions WHERE confirmed = true`);
      for (const sub of subs) {
        const cats = (sub.categories || '').split('|').filter(Boolean);
        const inds = (sub.tender_industries || '').split('|').filter(Boolean);
        const matching = cats.length ? fresh.filter((v) => cats.includes(v.category)) : fresh;
        // Tendre chodia len tým, ktorí si vybrali odvetvia (inak by digest spamoval stovkami zákaziek)
        const matchingTenders = inds.length ? freshTenders.filter((t) => inds.includes(t.industry)) : [];
        if (!matching.length && !matchingTenders.length) continue;

        const parts = [];
        if (matching.length) {
          const lines = matching.map((v) => {
            const amount = v.amount_max
              ? ` (do ${Number(v.amount_max).toLocaleString('sk-SK')} €)`
              : v.allocation ? ` (alokácia ${Number(v.allocation).toLocaleString('sk-SK')} €)` : '';
            const dl = v.deadline
              ? `, uzávierka ${new Date(v.deadline).toLocaleDateString('sk-SK')}`
              : v.deadline_note ? `, ${v.deadline_note}` : '';
            return `• ${v.title}${amount}${dl}\n  ${baseUrl}/vyzvy/${v.slug}`;
          });
          parts.push(`GRANTY (${matching.length}):\n\n` + lines.join('\n\n'));
        }
        if (matchingTenders.length) {
          const tLines = matchingTenders.slice(0, 15).map((t) => {
            const val = t.value_eur ? ` (${Number(t.value_eur).toLocaleString('sk-SK')} €)` : '';
            const dl = t.deadline ? `, lehota ${new Date(t.deadline).toLocaleDateString('sk-SK')}` : '';
            return `• ${t.title}${val}${dl}\n  ${baseUrl}/tendre/${t.id}`;
          });
          const more = matchingTenders.length > 15 ? `\n… a ďalších ${matchingTenders.length - 15} zákaziek: ${baseUrl}/tendre` : '';
          parts.push(`TENDRE (${matchingTenders.length}):\n\n` + tLines.join('\n\n') + more);
        }
        const unsubscribe = `${baseUrl}/grantovy-radar/odhlasit?email=${encodeURIComponent(sub.email)}&t=${unsubToken(sub.email)}`;
        const total = matching.length + matchingTenders.length;

        // HTML digest — karty ako na webe
        let bodyHtml = '';
        if (matching.length) {
          bodyHtml += mail.sectionHeading(`Granty (${matching.length})`);
          for (const v of matching) {
            const amount = v.amount_max
              ? `do ${Number(v.amount_max).toLocaleString('sk-SK')} €`
              : v.allocation ? `alokácia ${Number(v.allocation).toLocaleString('sk-SK')} €` : 'suma neurčená';
            const dl = v.deadline
              ? `uzávierka ${new Date(v.deadline).toLocaleDateString('sk-SK')}`
              : (v.deadline_note || 'bez pevnej uzávierky');
            bodyHtml += mail.itemCard({
              url: `${baseUrl}/vyzvy/${v.slug}`,
              title: v.ai_title || v.title,
              subtitle: v.ai_teaser || v.provider || v.category,
              facts: `${mail.strong(amount)} &nbsp;·&nbsp; ${dl}`,
            });
          }
        }
        if (matchingTenders.length) {
          bodyHtml += mail.sectionHeading(`Tendre (${matchingTenders.length})`);
          for (const t of matchingTenders.slice(0, 15)) {
            const val = t.value_eur ? `${Number(t.value_eur).toLocaleString('sk-SK')} €` : 'hodnota neuvedená';
            const dl = t.deadline ? `lehota ${new Date(t.deadline).toLocaleDateString('sk-SK')}` : 'lehota neuvedená';
            bodyHtml += mail.itemCard({
              url: `${baseUrl}/tendre/${t.id}`,
              title: t.title,
              subtitle: t.buyer_name || 'Verejný obstarávateľ',
              facts: `${mail.strong(val)} &nbsp;·&nbsp; ${dl}`,
            });
          }
          if (matchingTenders.length > 15) {
            bodyHtml += mail.small(`… a ďalších ${matchingTenders.length - 15} zákaziek.`);
          }
        }
        bodyHtml += mail.button(`${baseUrl}/${matching.length ? 'vyzvy' : 'tendre'}`, 'Zobraziť všetko v GrantHube');

        const html = mail.shell({
          preheader: `${total} noviniek z vašich oblastí`,
          heading: 'Nové výzvy a zákazky pre vás',
          introHtml: mail.para(`Dobrý deň, v GrantHube pribudlo ${mail.strong(total)} noviniek z oblastí, ktoré sledujete.`),
          bodyHtml,
          reason: 'Tento súhrn dostávate, lebo ste si v GrantHube zapli radar. Odber viete kedykoľvek vypnúť.',
          unsub: unsubscribe,
        });

        await sendMail({
          to: sub.email,
          subject: `GrantHub: ${total === 1 ? '1 nová položka'
            : total <= 4 ? `${total} nové položky`
            : `${total} nových položiek`} vo vašich oblastiach`,
          text:
            `Dobrý deň,\n\nv GrantHube pribudli novinky z oblastí, ktoré sledujete:\n\n` +
            parts.join('\n\n————————————\n\n') +
            `\n\n—\nOdber radaru zrušíte tu: ${unsubscribe}`,
          html,
        });
        sent++;
      }
    }
  }

  // Strážcovia — uložené hľadania tendrov s notifikáciami (registrovaní používatelia)
  let watcherEmails = 0;
  if (lastRun) {
    const { rows: freshT } = await pool.query(
      `SELECT * FROM tenders WHERE created_at > $1 AND (deadline IS NULL OR deadline >= now())`, [lastRun]);
    if (freshT.length) {
      const { rows: watchers } = await pool.query(
        `SELECT ts.*, u.email FROM tender_searches ts JOIN users u ON u.id = ts.user_id WHERE ts.notify = true`);
      const byEmail = new Map();
      for (const w of watchers) {
        const hits = freshT.filter((t) =>
          (!w.q || t.search_blob.includes(foldText(w.q))) &&
          (!w.industry || t.industry === w.industry) &&
          (!w.region_code || t.region_code === w.region_code) &&
          (!w.cpv || t.main_cpv.startsWith(w.cpv)) &&
          (!w.min_value || (t.value_eur && Number(t.value_eur) >= Number(w.min_value)))
        );
        if (!hits.length) continue;
        if (!byEmail.has(w.email)) byEmail.set(w.email, []);
        byEmail.get(w.email).push({ watcher: w, hits });
      }
      for (const [email, groups] of byEmail) {
        let bodyHtml = '';
        const textLines = [];
        for (const g of groups) {
          bodyHtml += mail.sectionHeading(`Strážca „${g.watcher.name}“ (${g.hits.length})`);
          textLines.push(`Strážca „${g.watcher.name}“:`);
          for (const t of g.hits.slice(0, 10)) {
            const val = t.value_eur ? `${Number(t.value_eur).toLocaleString('sk-SK')} €` : 'hodnota neuvedená';
            const dl = t.deadline ? `lehota ${new Date(t.deadline).toLocaleDateString('sk-SK')}` : 'lehota neuvedená';
            bodyHtml += mail.itemCard({
              url: `${baseUrl}/tendre/${t.id}`,
              title: t.title,
              subtitle: t.buyer_name || 'Verejný obstarávateľ',
              facts: `${mail.strong(val)} &nbsp;·&nbsp; ${dl}`,
            });
            textLines.push(`- ${t.title}\n  ${baseUrl}/tendre/${t.id}`);
          }
          if (g.hits.length > 10) bodyHtml += mail.small(`… a ďalších ${g.hits.length - 10}.`);
        }
        bodyHtml += mail.button(`${baseUrl}/ucet/straznici`, 'Spravovať strážcov');
        const totalHits = groups.reduce((n, g) => n + g.hits.length, 0);
        await sendMail({
          to: email,
          subject: `GrantHub: ${totalHits === 1 ? '1 nový tender' : totalHits <= 4 ? `${totalHits} nové tendre` : `${totalHits} nových tendrov`} pre vašich strážcov`,
          text: `Dobrý deň,\n\nvaši strážcovia našli nové tendre:\n\n` + textLines.join('\n') + `\n\nSpravovať strážcov: ${baseUrl}/ucet/straznici`,
          html: mail.shell({
            preheader: `${totalHits} nových tendrov pre vašich strážcov`,
            heading: 'Vaši strážcovia našli nové tendre',
            introHtml: mail.para(`Dobrý deň, uložené vyhľadávania našli ${mail.strong(totalHits)} nových zákaziek.`),
            bodyHtml,
            reason: 'Tento e-mail dostávate, lebo máte v GrantHube uložených strážcov trhu s notifikáciami. Vypnete ich v účte.',
          }),
        });
        watcherEmails++;
      }
    }
  }

  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('radar_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [now.toISOString()]
  );

  return { firstRun: !lastRun, newVyzvy: newCount, newTendre: newTenders, emailsSent: sent, watcherEmails };
}

module.exports = { runRadar, unsubToken };
