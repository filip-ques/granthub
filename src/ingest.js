// Ingest otvorených výziev z ITMS2014+ Open Data API (opendata.itms2014.sk).
// Obdobie 2014 – 2020 (druh VYZVA) aj Program Slovensko 2021 – 2027 (druh VYZVA_21).
// Pre každú otvorenú výzvu sa sťahuje aj detail: oficiálne odkazy na dokumentáciu,
// kontaktné osoby, konkrétne ciele a fond. Ukladajú sa len fakty z API.

const { pool } = require('./db');

const API = 'https://opendata.itms2014.sk';

// Zaradenie do oblasti podľa rezortu vyhlasovateľa
const PROVIDER_CATEGORY = [
  { re: /životného prostredia/i, cat: 'Ochrana životného prostredia' },
  { re: /pôdohospodárstva|platobná agentúra/i, cat: 'Pôdohospodárstvo a lesníctvo' },
  { re: /hospodárstva/i, cat: 'Rozvoj podnikania' },
  { re: /školstva|vedy, výskumu/i, cat: 'Vzdelávanie' },
  { re: /práce, sociálnych/i, cat: 'Zamestnanosť' },
  { re: /zdravotníctva/i, cat: 'Sociálne služby a zdravotníctvo' },
  { re: /dopravy/i, cat: 'Doprava a cyklodoprava' },
  { re: /kultúry/i, cat: 'Kultúra, cestovný ruch a šport' },
];

// Spresnenie podľa textu konkrétneho cieľa (keď rezort nestačí)
const OBJECTIVE_CATEGORY = [
  { re: /výskum|inováci/i, cat: 'Veda a výskum' },
  { re: /energet|obnoviteľn/i, cat: 'Energetika a OZE' },
  { re: /digit|informatiz|IKT/i, cat: 'Digitalizácia a IT' },
  { re: /vzdeláv|škol/i, cat: 'Vzdelávanie' },
  { re: /zamestnan/i, cat: 'Zamestnanosť' },
  { re: /sociáln|zdravot/i, cat: 'Sociálne služby a zdravotníctvo' },
  { re: /odpad|klím|klimat|environ|vod|biodiverz/i, cat: 'Ochrana životného prostredia' },
  { re: /doprav|cyklo|mobilit/i, cat: 'Doprava a cyklodoprava' },
  { re: /kultúr|cestovn|šport/i, cat: 'Kultúra, cestovný ruch a šport' },
  { re: /podnik|MSP|konkurencieschopn/i, cat: 'Rozvoj podnikania' },
];

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ITMS API ${path} -> ${res.status}`);
  return res.json();
}

// Jednoduchá per-beh cache pre číselníky a subjekty
function cachedFetcher() {
  const cache = new Map();
  return async (path) => {
    if (!cache.has(path)) {
      cache.set(path, await fetchJson(path).catch(() => null));
    }
    return cache.get(path);
  };
}

function isOpen(v, now) {
  if (v.stav !== 'Vyhlásená') return false;
  if (!['VYZVA', 'VYZVA_21'].includes(v.druh)) return false;
  if (v.datumUzavretia && new Date(v.datumUzavretia) < now) return false;
  return true;
}

function pickCategory(provider, objectives) {
  const byProvider = provider && PROVIDER_CATEGORY.find((m) => m.re.test(provider));
  if (byProvider) return byProvider.cat;
  const text = objectives || '';
  const byObjective = OBJECTIVE_CATEGORY.find((m) => m.re.test(text));
  return byObjective ? byObjective.cat : 'Eurofondy';
}

async function runIngest() {
  const now = new Date();
  const all = await fetchJson('/v2/vyzvy/vyhlasene?limit=100000');
  const open = all.filter((v) => isOpen(v, now));
  const cached = cachedFetcher();

  let inserted = 0;
  let updated = 0;
  let detailErrors = 0;

  for (const v of open) {
    // Detail výzvy — odkazy, kontakty, ciele, fond
    let detail = null;
    try {
      detail = await fetchJson(`/v2/vyzvy/vyhlasene/${v.id}`);
    } catch {
      detailErrors++;
    }
    const d = detail || v;

    const subj = d.vyhlasovatel ? await cached(`/v2/subjekty/${d.vyhlasovatel.id}`) : null;
    const provider = subj ? subj.nazov : null;

    // Konkrétne ciele (názvy cez číselník)
    const cieleRefs = (d.konkretneCieleTypyAktivit || []).map((k) => k.konkretnyCiel)
      .concat(d.konkretneCiele || []);
    const seenCiele = new Set();
    const cieleNazvy = [];
    for (const ref of cieleRefs) {
      if (!ref || seenCiele.has(ref.id)) continue;
      seenCiele.add(ref.id);
      const c = await cached(`/v2/konkretnyCiel/${ref.id}`);
      if (c && c.nazov) cieleNazvy.push(c.nazov.trim());
      if (cieleNazvy.length >= 4) break;
    }
    const objectives = cieleNazvy.length ? cieleNazvy.join('\n') : null;

    // Fond(y)
    const fondNazvy = [];
    for (const f of d.fondy || []) {
      const fd = await cached(`/v2/hodnotaCiselnika/${f.ciselnikKod}/hodnota/${f.id}`);
      if (fd && fd.nazov) fondNazvy.push(fd.nazov);
    }
    const fund = fondNazvy.length ? [...new Set(fondNazvy)].join(', ') : null;

    // Oficiálne odkazy a kontakty
    const links = (d.doplnujuceInfo || [])
      .filter((l) => l && l.url)
      .map((l) => ({ nazov: l.nazov || 'Odkaz', url: l.url }));
    const contacts = (d.kontaktneOsoby || []).map((k) => ({
      meno: k.menoUplne || [k.meno, k.priezvisko].filter(Boolean).join(' '),
      email: k.email || null,
      telefon: k.telefon || null,
    }));

    const category = pickCategory(provider, objectives);
    const allocation = (d.alokaciaEU || 0) + (d.alokaciaSR || 0) || null;
    const program = d.druh === 'VYZVA_21' ? 'Program Slovensko 2021 – 2027' : 'EŠIF 2014 – 2020';
    const deadline = d.datumUzavretia ? d.datumUzavretia.slice(0, 10) : null;
    const deadlineNote = deadline ? null : 'otvorená — spravidla do vyčerpania alokácie';
    const announced = d.datumVyhlasenia ? d.datumVyhlasenia.slice(0, 10) : null;
    // Popis = prvý konkrétny cieľ (reálny obsah výzvy); inak faktický fallback
    const firstObjective = cieleNazvy.length ? cieleNazvy[0].replace(/^[A-Z0-9.]+\s*/, '') : null;
    const summary = firstObjective
      ? (firstObjective.length > 260 ? firstObjective.slice(0, 257) + '…' : firstObjective)
      : `Oficiálna výzva ${d.kod}. Podrobné podmienky a oprávnenosť žiadateľov nájdete v dokumentácii výzvy.`;
    const sourceUrl = links.length ? links[0].url : `${API}/v2/vyzvy/vyhlasene/${d.id}`;

    const res = await pool.query(
      `INSERT INTO vyzvy (slug, title, provider, program, category, applicants, regions,
                          allocation, deadline, deadline_note, summary, source_url, status, source,
                          links, contacts, objectives, fund, code, announced)
       VALUES ($1,$2,$3,$4,$5,'podľa dokumentácie výzvy','Celé Slovensko',$6,$7,$8,$9,$10,'otvorena','itms',$11,$12,$13,$14,$15,$16)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, provider = EXCLUDED.provider, program = EXCLUDED.program,
         category = EXCLUDED.category, allocation = EXCLUDED.allocation,
         deadline = EXCLUDED.deadline, deadline_note = EXCLUDED.deadline_note,
         summary = EXCLUDED.summary, source_url = EXCLUDED.source_url, status = 'otvorena',
         links = EXCLUDED.links, contacts = EXCLUDED.contacts,
         objectives = EXCLUDED.objectives, fund = EXCLUDED.fund,
         code = EXCLUDED.code, announced = EXCLUDED.announced
       RETURNING (xmax = 0) AS inserted`,
      [`itms-${d.id}`, d.nazov, provider, program, category, allocation,
       deadline, deadlineNote, summary, sourceUrl,
       links.length ? JSON.stringify(links) : null,
       contacts.length ? JSON.stringify(contacts) : null,
       objectives, fund, d.kod || null, announced]
    );
    if (res.rows[0].inserted) inserted++; else updated++;
  }

  // Výzvy z ITMS, ktoré už nie sú otvorené, uzavri
  const openSlugs = open.map((v) => `itms-${v.id}`);
  const { rowCount: closed } = await pool.query(
    `UPDATE vyzvy SET status = 'uzavreta'
     WHERE source = 'itms' AND status = 'otvorena' AND NOT (slug = ANY($1))`,
    [openSlugs]
  );

  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('ingest_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [now.toISOString()]
  );

  return { total: all.length, open: open.length, inserted, updated, closed, detailErrors };
}

module.exports = { runIngest };
