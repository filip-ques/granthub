// Číselníky a statické dáta portálu

const CATEGORIES = [
  'Rozvoj podnikania',
  'Kultúra, cestovný ruch a šport',
  'Pôdohospodárstvo a lesníctvo',
  'Veda a výskum',
  'Vzdelávanie',
  'Ochrana životného prostredia',
  'Energetika a OZE',
  'Sociálne služby a zdravotníctvo',
  'Občianska vybavenosť',
  'Zamestnanosť',
  'Doprava a cyklodoprava',
  'Digitalizácia a IT',
  'Eurofondy',
];

const APPLICANTS = [
  'podnikatelia',
  'samospráva',
  'mimovládne organizácie',
  'akademický sektor',
  'štátna správa',
  'jednotlivci',
];

const REGIONS = [
  'Bratislavský kraj',
  'Trnavský kraj',
  'Trenčiansky kraj',
  'Nitriansky kraj',
  'Žilinský kraj',
  'Banskobystrický kraj',
  'Prešovský kraj',
  'Košický kraj',
];

const SEGMENTS = [
  {
    slug: 'pre-podnikatelov',
    title: 'Granty pre podnikateľov',
    applicantKey: 'podnikatelia',
    lead: 'Dotácie na inovácie, technológie, energetiku, digitalizáciu aj expanziu do zahraničia — pre živnostníkov, malé firmy aj priemysel.',
    points: [
      'Vouchery a poukážky na fotovoltiku, tepelné čerpadlá a úspory energií',
      'Inovačné poukážky na robotizáciu, automatizáciu a Industry 4.0',
      'Kaskádové výzvy Horizon Europe pre malé a stredné podniky',
      'Podpora účasti na zahraničných veľtrhoch a výstavách',
    ],
  },
  {
    slug: 'pre-mesta-a-obce',
    title: 'Granty pre mestá a obce',
    applicantKey: 'samospráva',
    lead: 'Výzvy pre samosprávy — od zelene a vodozádržných opatrení cez sociálne služby až po občiansku vybavenosť.',
    points: [
      'Revitalizácia verejných priestranstiev a výsadba zelene',
      'Sociálne taxíky, AED a dostupnosť zdravotnej starostlivosti',
      'Centrá opätovného použitia a predchádzanie vzniku odpadov',
      'Vodozádržné opatrenia a adaptácia na zmenu klímy',
    ],
  },
  {
    slug: 'pre-skoly',
    title: 'Granty pre školy a akademický sektor',
    applicantKey: 'akademický sektor',
    lead: 'Podpora vzdelávania, vedy a výskumu pre školy, univerzity a výskumné inštitúcie.',
    points: [
      'Výzvy na vzdelávacie projekty a modernizáciu výučby',
      'Vedecko-výskumné projekty a medzinárodné konzorciá',
      'Digitalizácia škôl',
    ],
  },
  {
    slug: 'pre-mimovladne-organizacie',
    title: 'Granty pre mimovládne organizácie',
    applicantKey: 'mimovládne organizácie',
    lead: 'Financovanie pre občianske združenia, neziskovky a nadácie — od komunitných projektov po inštitucionálny rozvoj.',
    points: [
      'Inštitucionálny rozvoj a stabilita občianskych organizácií',
      'Bilaterálne iniciatívy a medzinárodná spolupráca',
      'Kultúrne podujatia a komunitné projekty v regiónoch',
      'Sociálne služby a pomoc zraniteľným skupinám',
    ],
  },
  {
    slug: 'pre-jednotlivcov',
    title: 'Granty pre jednotlivcov',
    applicantKey: 'jednotlivci',
    lead: 'Podpora pre fyzické osoby — mladých farmárov, tvorcov aj domácnosti.',
    points: [
      'Investičná podpora pre mladých poľnohospodárov',
      'Štipendiá a tvorivé projekty',
      'Príspevky pre domácnosti na obnoviteľné zdroje',
    ],
  },
];

const SERVICES = [
  {
    kind: 'grant',
    slug: 'napasovanie-na-vyzvu',
    name: 'Napasovanie firmy na konkrétnu výzvu',
    shortName: 'Napasovanie na výzvu',
    price: 499,
    origPrice: 998,
    priceNote: 'od 499 € bez DPH',
    lead: 'Posúdime, či vaša firma alebo organizácia spĺňa podmienky konkrétnej výzvy, a povieme vám na rovinu, či má zmysel žiadať.',
    includes: [
      'Kontrola oprávnenosti žiadateľa (právna forma, veľkosť podniku, región, história)',
      'Kontrola oprávnenosti zámeru — či váš projekt sedí na aktivity a ciele výzvy',
      'Posúdenie šancí podľa hodnotiacich kritérií výzvy',
      'Odporúčanie: žiadať / upraviť zámer / počkať na vhodnejšiu výzvu',
      'Písomný výstup do 5 pracovných dní',
    ],
  },
  {
    kind: 'grant',
    slug: 'vypracovanie-projektu',
    name: 'Vypracovanie projektu a žiadosti o grant',
    shortName: 'Vypracovanie projektu',
    price: 999,
    origPrice: 1998,
    priceNote: 'od 999 € bez DPH',
    lead: 'Kompletne pripravíme žiadosť o grant — od projektového zámeru cez rozpočet až po podanie v systéme.',
    includes: [
      'Spracovanie projektového zámeru a opisu projektu',
      'Zostavenie rozpočtu a harmonogramu',
      'Nastavenie merateľných ukazovateľov',
      'Kompletizácia povinných príloh',
      'Podanie žiadosti a komunikácia s vyhlasovateľom do vydania rozhodnutia',
    ],
  },
  {
    kind: 'tender',
    slug: 'overenie-podmienok-tendra',
    name: 'Overenie splnenia podmienok tendra',
    shortName: 'Overenie podmienok',
    price: 249,
    origPrice: 499,
    priceNote: 'od 249 € bez DPH',
    lead: 'Skontrolujeme, či vaša firma spĺňa podmienky účasti v konkrétnom tendri — skôr než investujete čas do ponuky.',
    includes: [
      'Analýza súťažných podkladov a podmienok účasti',
      'Kontrola referencií, obratu a spôsobilosti vašej firmy',
      'Prehľad chýbajúcich dokladov a rizík',
      'Odporúčanie „ísť / neísť“ do zákazky',
    ],
  },
  {
    kind: 'tender',
    slug: 'vytvorenie-podania-tendra',
    name: 'Vytvorenie podania na tender',
    shortName: 'Podanie na tender',
    price: 499,
    origPrice: 999,
    priceNote: 'od 499 € bez DPH',
    lead: 'Pripravíme kompletnú ponuku do verejného obstarávania na kľúč — od podkladov cez formuláre až po elektronické podanie.',
    includes: [
      'Všetko z overenia splnenia podmienok',
      'Príprava a kompletizácia celej ponuky',
      'Vyplnenie formulárov a čestných vyhlásení',
      'Kontrola úplnosti a elektronické podanie v systéme',
      'Konzultácie počas celej lehoty na predkladanie',
    ],
  },
];

module.exports = { CATEGORIES, APPLICANTS, REGIONS, SEGMENTS, SERVICES };
