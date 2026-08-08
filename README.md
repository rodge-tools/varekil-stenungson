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
