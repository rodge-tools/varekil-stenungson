# Varekil ↔ Stenungsön – molnversion

Den här versionen är avsedd att ligga på en webbtjänst (t.ex. Render) så att samma app kan användas på flera Android-telefoner.

## Viktigt om API-nycklar

Lägg INTE `config.json` med Client Secret i GitHub. Den här mappen innehåller därför ingen `config.json`, och `.gitignore` blockerar filen om du råkar skapa den lokalt.

På servern används i stället miljövariabler:

- `VASTTRAFIK_CLIENT_ID`
- `VASTTRAFIK_CLIENT_SECRET`
- `STOP_A` = `Varekil busstation`
- `STOP_B` = `Stenungsön`

## Render – snabbguide

1. Skapa ett nytt privat GitHub-repository, till exempel `varekil-stenungson`.
2. Packa upp denna ZIP och ladda upp filerna i repositoryts rot. Ladda aldrig upp en lokal `config.json`.
3. Logga in på Render och välj **New → Web Service**.
4. Anslut GitHub-repositoryt.
5. Välj Python 3.
6. Build Command: `pip install -r requirements.txt`
7. Start Command: `gunicorn app:app`
8. Lägg till miljövariablerna `VASTTRAFIK_CLIENT_ID` och `VASTTRAFIK_CLIENT_SECRET` med dina riktiga Västtrafik-uppgifter.
9. Lägg även till `STOP_A=Varekil busstation` och `STOP_B=Stenungsön` om de inte redan sätts från `render.yaml`.
10. Starta deploymenten. När den är klar får du en HTTPS-adress, exempelvis `https://varekil-stenungson.onrender.com`.

## På varje Android-telefon

1. Öppna HTTPS-adressen i Chrome.
2. Chrome-menyn → **Installera app** eller **Lägg till på startskärmen**.
3. Upprepa på alla telefoner som ska ha appen.

Alla telefoner använder då samma server. Client Secret skickas inte till telefonerna.

## Om Render Free

Gratis Web Service kan somna efter en stunds inaktivitet. Första öppningen efter vila kan därför ta längre tid. En betald instans kan användas om du vill slippa väntetiden.
