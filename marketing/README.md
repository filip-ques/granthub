# Marketingové materiály GrantHub

- `granthub-onepager.pdf` — produktový list A4 (tlač aj e-mail príloha)
- `granthub-prezentacia.pdf` — prezentácia 16:9 (9 slajdov, pitch pre firmy/partnerov)
- `email-sablony.md` — 4 šablóny (studený kontakt, follow-up, obce, novinka obstarávanie)
- `socialne-siete.md` — LinkedIn / Facebook / krátke formáty
- `*.png` — screenshoty webu použité v prezentácii

Regenerovanie PDF (napr. po zmene čísel v `generate.js`):
```
node marketing/generate.js marketing
```
Čísla výziev/tendrov aktualizuj v `generate.js` (N_VYZVY, N_TENDRE, STAT_DATE) podľa granthub.sk.
