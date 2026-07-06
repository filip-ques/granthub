# GrantHub — granty, dotácie a verejné zákazky

Portál o grantoch a dotáciách v dizajne rodiny iTender Monitor (monitor.itender.sk) —
EU modrá `#004494`, žltý akcent, flat komponenty, Arial. Celá databáza výziev je zadarmo (bez paywallu,
vrátane vyhlasovateľa a súm); monetizácia je výhradne cez dve platené služby:

- **Napasovanie firmy na konkrétnu výzvu** — od 499 € bez DPH (bežná cena 998 €, −50 %)
- **Vypracovanie projektu a žiadosti o grant** — od 999 € bez DPH (bežná cena 1 998 €, −50 %)

## Stack

- Node.js 22 + Express 5, server-rendered EJS (rýchle, SEO-friendly, mobile-first)
- PostgreSQL (`pg`) — používatelia, magic link tokeny, výzvy, uložené výzvy, objednávky, radar, sessions
- Prihlásenie **bez hesla cez magic link** (jednorazový token, platnosť 15 minút)
- Externé SMTP cez `nodemailer` (magic linky, potvrdenia objednávok, notifikácie)
- Nasadenie: **Cloudflare Containers** (Dockerfile + Worker proxy)

## Lokálny vývoj

```bash
# 1. Postgres (ak nemáš vlastný)
docker run -d --name grantexpert-pg -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=grantexpert -p 5433:5432 postgres:16

# 2. Závislosti + seed reálnych výziev
npm install
npm run seed

# 3. Spustenie (DEV_MODE=1 zobrazí magic link priamo na stránke)
PORT=3100 DEV_MODE=1 npm run dev
```

Bez nastaveného `SMTP_HOST` sa e-maily vypisujú do konzoly — na vývoj to stačí.
Všetky premenné prostredia sú popísané v [.env.example](.env.example).

## Joby a automatická aktualizácia databázy

- **Ingest** (`POST /cron/ingest`) — sťahuje otvorené výzvy z oficiálneho open data API
  ITMS2014+ (`opendata.itms2014.sk`), vrátane Programu Slovensko 2021 – 2027. Pre každú
  výzvu ťahá aj detail: názov vyhlasovateľa, oficiálne odkazy na dokumentáciu, kontaktné
  osoby, konkrétne ciele a fond (EFRR/ESF+/FST/KF). Nové výzvy pridá, zmenené aktualizuje, zaniknuté uzavrie. Ukladá len
  fakty z API (slug `itms-*`, `source = 'itms'`); ručne pridané výzvy (`source = 'manual'`)
  nikdy neprepisuje.
- **Ingest tendrov** (`POST /cron/tendre`) — sťahuje slovenské verejné zákazky z oficiálneho
  TED Search API v3 (api.ted.europa.eu, bez API kľúča): názov, obstarávateľ, CPV, odvetvie,
  región, hodnota, lehoty, odkazy na oznámenie. Beží v rovnakom cron cykle ako granty.
- **Radar digest** (`POST /cron/radar`) — odberateľom pošle e-mail o výzvach, ktoré pribudli
  od posledného behu (filtrované podľa ich oblastí), s odhlasovacím odkazom (HMAC token).
  Prvý beh nič neposiela, len si zapamätá stav.

Oba endpointy vyžadujú hlavičku `Authorization: Bearer $CRON_SECRET`
(lokálne bez nastaveného tajomstva bežia voľne, v produkcii bez neho vrátia 503).

Spúšťanie:
- **Cloudflare**: Cron Trigger každých 6 hodín (`wrangler.jsonc -> triggers.crons`);
  Worker (`worker.js -> scheduled`) zavolá ingest a hneď po ňom radar.
- **Mimo Cloudflare** (VPS/Docker): nastav `ENABLE_INTERNAL_CRON=1` — joby beží priamo
  v aplikácii každých 6 hodín (prvý beh 15 s po štarte).

## Firemná zóna (prihlásení používatelia, všetko zadarmo)

- **Strážcovia trhu** — uložené vyhľadávania tendrov (slovo/odvetvie/kraj/CPV/hodnota);
  pri nových zhodách chodí e-mail v digeste. Ukladajú sa priamo z filtrov na /tendre.
- **Moje tendre (pipeline)** — board Sledujem → Pripravujem → Podané → Vyhraté/Prehraté
  s poznámkami; zákazky sa pridávajú tlačidlom Uložiť na detaile tendra.
- **Produkty** — katalóg toho, čo firma ponúka (kľúčové slová + CPV prefixy),
  s automatickým párovaním otvorených tendrov (/ucet/produkty/:id/zhody).

## Cenník a služby

Monitoring je celý zadarmo. Platené sú 4 jednorazové služby (všetky −50 %):
granty — napasovanie od 499 € a vypracovanie projektu od 999 €;
tendre — overenie splnenia podmienok od 249 € a vytvorenie podania od 499 €.
Objednávky sa viažu na konkrétnu výzvu (?vyzva=slug) alebo tender (?tender=id).

## E-maily

Všetky e-maily (magic link, radar digest, strážcovia, objednávky) majú jednotný
HTML dizajn (src/mailer.js: shell/button/itemCard) s hlavičkou GrantHub a právne
korektnou pätičkou; plain-text alternatíva sa posiela vždy.

## Admin zóna

`/admin` — len pre e-maily v `ADMIN_EMAILS` (default `filip@ques.sk`), prihlásenie bežným
magic linkom. Obsahuje prehľad (KPI + posledné behy jobov), správu výziev (úprava,
vytváranie manuálnych, mazanie), objednávky so zmenou stavu a zoznam radar odberov.
Výzvy so `source = 'itms'` prepisuje ingest — trvalé ručné úpravy rob v manuálnych výzvach.

## Nasadenie na Cloudflare Containers

Predpoklady: externý Postgres (Neon/Supabase/Hyperdrive-kompatibilný…), externé SMTP
(Resend/Postmark/SES/…), účet Cloudflare s povolenými Containers a `wrangler` v4+.

```bash
npm install -D wrangler @cloudflare/containers

# tajomstvá Workera (prenesú sa do kontajnera cez worker.js)
wrangler secret put DATABASE_URL
wrangler secret put SESSION_SECRET
wrangler secret put SMTP_HOST
wrangler secret put SMTP_USER
wrangler secret put SMTP_PASS
wrangler secret put MAIL_FROM
wrangler secret put BASE_URL        # napr. https://granty.example.sk
wrangler secret put CRON_SECRET     # `openssl rand -hex 32` — pre /cron/* endpointy
wrangler secret put ADMIN_EMAILS    # e-maily správcov, default filip@ques.sk
wrangler secret put ORDERS_EMAIL    # kam chodia objednávky (voliteľné)

# build obrazu + deploy (wrangler postaví Dockerfile a nahrá ho do Cloudflare registry)
wrangler deploy

# jednorazovo naplň DB výzvami (spusti lokálne proti produkčnej DB)
DATABASE_URL=postgres://... DATABASE_SSL=1 npm run seed
```

Worker (`worker.js`) proxuje všetky requesty do kontajnera; kontajner beží na porte 8080
a po 10 minútach bez prevádzky sa uspí (platíš len za beh).

## Štruktúra

```
server.js          Express aplikácia a všetky routy
src/db.js          pg Pool + schéma (CREATE TABLE IF NOT EXISTS pri štarte)
src/auth.js        magic link prihlásenie + session middleware
src/mailer.js      SMTP cez nodemailer, fallback do konzoly
src/data.js        číselníky: oblasti, žiadatelia, kraje, segmenty, služby
src/seed.js        seed reálnych grantových výziev (fakty k 5. 7. 2026)
views/             EJS šablóny
public/css/app.css  dizajn systém (zdieľaný s monitor.itender.sk)
worker.js          Cloudflare Worker → Container proxy
wrangler.jsonc     Cloudflare Containers konfigurácia
```

## Dátová poctivosť

Vo výzvach sú len overené fakty z verejných zdrojov. Ak zdroj neuvádza vyhlasovateľa,
pole je `NULL` a na webe sa zobrazí „uvedený v dokumentácii výzvy“ — nič sa nedomýšľa.
Na webe nie sú žiadne vymyslené štatistiky, referencie ani firemné údaje.

## Prevádzkovateľ

Ayerf s. r. o., Ľubovnianska 12, 851 07 Bratislava - mestská časť Petržalka
IČO: 50991175 · DIČ: 2120570034 · IČ DPH: SK2120570034 (§4, registrácia od 1. 11. 2025)
