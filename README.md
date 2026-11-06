# Varekil ↔ Stenungsön

En liten mobilanpassad PWA som visar Västtrafik-resor mellan Varekil och Stenungsön i båda riktningarna.

## 1. Skaffa Västtrafik API-uppgifter

1. Skapa konto på Västtrafiks utvecklarportal.
2. Skapa en applikation.
3. Prenumerera på **Planera Resa v4**.
4. Kopiera Client ID och Client Secret.

## 2. Lägg in uppgifterna

Kopiera `config.example.json` till `config.json` och fyll i dina uppgifter.

```json
{
  "vasttrafik_client_id": "...",
  "vasttrafik_client_secret": "...",
  "stop_a": "Varekil busstation",
  "stop_b": "Stenungsön"
}
```

Client Secret ligger bara på servern och skickas aldrig till webbläsaren.

## 3. Kör på dator/Raspberry Pi

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Öppna sedan `http://localhost:8080`.

## Android / PWA

När sidan publiceras via HTTPS kan den installeras från Chrome via **Lägg till på startskärmen / Installera app**.

## Funktioner

- Varekil → Stenungsön
- Stenungsön → Varekil
- Realtids-/beräknade tider när Västtrafik lämnar dem
- Linjenummer, ankomsttid, restid och byten
- Datum och tid
- "Visa fler avgångar" för att bläddra framåt
- Automatisk hållplatssökning via Västtrafik, så GID behöver inte skrivas in manuellt

## Teknik

- Backend: Python + Flask
- Västtrafik Planera Resa v4
- Frontend: HTML/CSS/vanilla JavaScript
- PWA: manifest + service worker

## Paginering och uppdatering

"Visa fler avgångar" använder `paginationReference` från Västtrafiks `links.next`.
Ursprunglig riktning, söktid och sidstorlek behålls genom hela sökningen. Ingen ny
söktid räknas ut från den sista resans ankomst eller avgång.

Backend returnerar `nextPaginationReference` (sträng eller `null`) och en `key`
per reseförslag. Nyckeln bygger på tur-ID, hållplats-ID och planerade datum/tider
för samtliga delresor. Realtidsuppdateringar ersätter tidigare versioner av samma
resa. Om identitetsuppgifter saknas behålls förslagen separat. Gånganslutningar
ingår också i identiteten; ändrade gångdata kan därför ge separata förslag.

Alla hämtade förslag sorteras efter avgång, ankomst och resenyckel. Datum och
klockslag visas, som tidigare, i enhetens lokala tidszon. Tomma sidor kan bläddras
förbi om en nästa referens finns. Vid nätverksfel kan samma sida hämtas igen.
En referens som leder tillbaka till en redan hämtad sida stoppar bläddringen och
visar ett meddelande om att starta en ny sökning.

Publicera backend, frontend och `sw.js` tillsammans. Cacheversionen är nu `v5`.
En redan öppen app måste laddas om för att köra den nya JavaScript-koden.
Ny frontend mot en äldre backend visar resorna men stänger av fortsatt bläddring
och visar att servern behöver uppdateras.

API:et lämnar optimerade reseförslag, inte nödvändigtvis alla tänkbara avgångar.
Se [Västtrafiks dokumentation, avsnitt 7.1.9](https://github.com/vasttrafik/api-pr-docs/blob/main/docs/REST.md#719-paginering).

## Tester

Backendtesterna använder Python-standardbibliotekets `unittest` och mockade
Västtrafiksvar:

```bash
pip install -r requirements.txt
python -m unittest discover -s tests -v
```

JavaScript- och DOM-testerna kör appens HTML och JavaScript i jsdom med mockade
API-svar. Använd Node.js 24 LTS, minst 24.15.0 (alternativt 22 LTS, minst
22.22.2). Node.js krävs endast för testerna, inte för drift:

```bash
npm ci
npm test
```

Webbläsartesterna kontrollerar dessutom beteendet i riktig Chromium, inklusive
läsposition vid omrendering:

```bash
npx playwright install chromium
npm run test:browser
```

På Linux kan `npx playwright install --with-deps chromium` behövas.
En redan installerad Chromium kan väljas med miljövariabeln
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
Testerna omfattar överlappande resor, samtidiga avgångar, dubbletter och
realtidsuppdateringar, midnatt, sommartidsomställning, tomma sidor, referenscykler,
återförsök, riktningsbyte samt bevarade öppna detaljer och läsposition.

För en kontroll mot live-API: starta appen med egna Västtrafik-uppgifter, sök i
båda riktningarna och bläddra flera sidor, även nära midnatt. Kontrollera i
webbläsarens nätverkspanel att `dateTime` är oförändrad och att nästa
`paginationReference` kommer från föregående svar. De automatiska testerna
använder inga API-nycklar och verifierar inte Västtrafiks aktuella trafikutbud
eller hur länge en pagineringsreferens är giltig.

## Håll Render vaken

Väckning och tillgänglighetskontroll hanteras externt via UptimeRobot med en
HTTP-kontroll var femte minut av:

`https://varekil-stenungson.onrender.com/api/health`

Hälsokontrollen gör inga resesökningar och behöver inga Västtrafik-nycklar.
GitHub Actions-jobbet för väckning har tagits bort eftersom schemalagda körningar
inte kom tillräckligt regelbundet. Hantera övervakningen i UptimeRobot.

Render kan fortfarande starta om tjänsten. Arbetsytans gratiskvot delas mellan
alla gratistjänster och förbrukas även när en tjänst hålls vaken av övervakningen.
