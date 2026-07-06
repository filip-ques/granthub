// Referenčné dáta pre tendre: kraje (NUTS), odvetvia (mapované z CPV divízií),
// CPV katalóg a typy oznámení. Portované z itender-radar (app/catalog.py).

const TENDER_REGIONS = [
  { code: 'SK010', name: 'Bratislavský kraj' },
  { code: 'SK021', name: 'Trnavský kraj' },
  { code: 'SK022', name: 'Trenčiansky kraj' },
  { code: 'SK023', name: 'Nitriansky kraj' },
  { code: 'SK031', name: 'Žilinský kraj' },
  { code: 'SK032', name: 'Banskobystrický kraj' },
  { code: 'SK041', name: 'Prešovský kraj' },
  { code: 'SK042', name: 'Košický kraj' },
];
const REGION_NAMES = Object.fromEntries(TENDER_REGIONS.map((r) => [r.code, r.name]));
// TED vracia hrubé NUTS-2 kódy (SK01..SK04) — mapujeme na reprezentatívny kraj
const NUTS2_TO_REGION = { SK01: 'SK010', SK02: 'SK021', SK03: 'SK031', SK04: 'SK041', SK0: '', SK: '' };

function normalizeRegion(raw) {
  if (!raw) return { code: '', name: '' };
  const code = String(raw).trim().toUpperCase();
  if (REGION_NAMES[code]) return { code, name: REGION_NAMES[code] };
  const via = NUTS2_TO_REGION[code] ?? NUTS2_TO_REGION[code.slice(0, 4)];
  if (via !== undefined) return { code: via || '', name: REGION_NAMES[via] || '' };
  return { code: '', name: '' };
}

const INDUSTRIES = [
  { key: 'stavebnictvo', label: 'Stavebníctvo', divisions: ['45', '44', '71'] },
  { key: 'it', label: 'IT a softvér', divisions: ['48', '72', '30'] },
  { key: 'doprava', label: 'Doprava a logistika', divisions: ['34', '60', '63'] },
  { key: 'zdravotnictvo', label: 'Zdravotníctvo', divisions: ['33', '85'] },
  { key: 'energetika', label: 'Energetika a elektro', divisions: ['09', '31', '65'] },
  { key: 'cistenie', label: 'Upratovanie a údržba', divisions: ['90', '50'] },
  { key: 'potraviny', label: 'Potraviny a gastro', divisions: ['15', '55'] },
  { key: 'bezpecnost', label: 'Bezpečnostné služby', divisions: ['79', '35'] },
  { key: 'poradenstvo', label: 'Poradenstvo a služby', divisions: ['73', '75', '80', '98'] },
  { key: 'kancelaria', label: 'Kancelária a nábytok', divisions: ['39', '22', '37'] },
  { key: 'ostatne', label: 'Ostatné', divisions: [] },
];
const INDUSTRY_LABELS = Object.fromEntries(INDUSTRIES.map((i) => [i.key, i.label]));
const DIVISION_TO_INDUSTRY = {};
for (const ind of INDUSTRIES) for (const div of ind.divisions) DIVISION_TO_INDUSTRY[div] = ind.key;

function industryForCpv(cpvCodes) {
  for (const code of cpvCodes || []) {
    const key = DIVISION_TO_INDUSTRY[String(code).slice(0, 2)];
    if (key) return key;
  }
  return 'ostatne';
}

const CPV_CATALOG = [
  ['03000000', 'Poľnohospodárske, farmárske produkty'],
  ['09000000', 'Ropné výrobky, palivá, elektrina a iné zdroje energie'],
  ['14000000', 'Ťažobné a základné produkty'],
  ['15000000', 'Potraviny, nápoje, tabak a príbuzné produkty'],
  ['18000000', 'Odevy, obuv, batožina a príslušenstvo'],
  ['22000000', 'Tlačoviny a príbuzné produkty'],
  ['24000000', 'Chemikálie'],
  ['30000000', 'Kancelárske a počítačové stroje, vybavenie'],
  ['31000000', 'Elektrické stroje, prístroje, zariadenia'],
  ['32000000', 'Rádiové, televízne a telekomunikačné zariadenia'],
  ['33000000', 'Zdravotnícke zariadenia, farmaceutické výrobky'],
  ['34000000', 'Prepravné zariadenia a pomocné výrobky'],
  ['35000000', 'Bezpečnostné, hasičské, policajné vybavenie'],
  ['37000000', 'Hudobné nástroje, športový tovar, hry'],
  ['38000000', 'Laboratórne, optické a presné prístroje'],
  ['39000000', 'Nábytok, zariadenie domácnosti, čistiace prostriedky'],
  ['42000000', 'Priemyselné stroje'],
  ['44000000', 'Stavebné konštrukcie a materiály'],
  ['45000000', 'Stavebné práce'],
  ['48000000', 'Softvérové balíky a informačné systémy'],
  ['50000000', 'Opravárske a údržbárske služby'],
  ['55000000', 'Hotelové, reštauračné a maloobchodné služby'],
  ['60000000', 'Dopravné služby (bez prepravy odpadu)'],
  ['63000000', 'Podporné a pomocné dopravné služby'],
  ['65000000', 'Verejné služby — energetika, voda'],
  ['66000000', 'Finančné a poisťovacie služby'],
  ['71000000', 'Architektonické, stavebné, inžinierske služby'],
  ['72000000', 'Služby IT: poradenstvo, vývoj softvéru, internet'],
  ['73000000', 'Výskumné a vývojové služby'],
  ['75000000', 'Verejná správa, obrana, sociálne zabezpečenie'],
  ['77000000', 'Poľnohospodárske, lesnícke, záhradnícke služby'],
  ['79000000', 'Podnikateľské služby: právo, marketing, personalistika'],
  ['80000000', 'Vzdelávacie a školiace služby'],
  ['85000000', 'Zdravotnícke a sociálne služby'],
  ['90000000', 'Kanalizačné, odpadové, čistiace a environmentálne služby'],
  ['92000000', 'Rekreačné, kultúrne a športové služby'],
  ['98000000', 'Iné služby pre verejnosť a domácnosti'],
];
const CPV_LABELS = Object.fromEntries(CPV_CATALOG);

function cpvLabel(code) {
  if (!code) return '';
  code = String(code);
  if (CPV_LABELS[code]) return CPV_LABELS[code];
  return CPV_LABELS[code.slice(0, 2) + '000000'] || `CPV ${code}`;
}

const NOTICE_TYPE_LABELS = {
  'cn-standard': 'Oznámenie o vyhlásení obstarávania',
  'cn-social': 'Oznámenie — sociálne služby',
  'cn-desg': 'Súťaž návrhov',
  'qu-sy': 'Kvalifikačný systém',
  'pin-only': 'Predbežné oznámenie',
  'pin-buyer': 'Predbežné oznámenie obstarávateľa',
  'can-standard': 'Oznámenie o výsledku obstarávania',
  'can-social': 'Výsledok — sociálne služby',
  'can-desg': 'Výsledok súťaže návrhov',
  veat: 'Oznámenie o dobrovoľnej transparentnosti',
  corr: 'Oprava / korigendum',
  subco: 'Subdodávateľská zákazka',
};

function noticeLabel(code) {
  if (!code) return 'Oznámenie';
  return NOTICE_TYPE_LABELS[code] || code.replace(/-/g, ' ');
}

// Diakritiku-necitlivé vyhľadávanie: zloží text do lowercase bez diakritiky
function foldText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

module.exports = {
  TENDER_REGIONS, REGION_NAMES, normalizeRegion,
  INDUSTRIES, INDUSTRY_LABELS, industryForCpv,
  CPV_CATALOG, cpvLabel, noticeLabel, foldText,
};
