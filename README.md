# Vorratskammer

Kleine App für zwei Personen: Was liegt im Keller, was im Außenlager?
Bestand per Live-Barcode-Scan mit der iPhone-Kamera oder per +/− pflegen, und schnell nachschauen, ob noch etwas da ist.

- Läuft als Web-App im Browser und lässt sich in Safari über **Teilen → Zum Home-Bildschirm** wie eine normale App ablegen.
- Gemeinsamer Bestand über Firebase Firestore, funktioniert auch ohne Empfang (Änderungen werden nachgereicht).
- Produktnamen kommen aus [Open Food Facts](https://world.openfoodfacts.org) (plus Open Products Facts und Open Beauty Facts).
- Barcode-Erkennung über ZXing (WebAssembly), da Safari keinen eingebauten Barcode-Leser hat.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Seite und Gestaltung |
| `src/main.js` | Oberfläche: Liste, Suche, Artikel, Scanner |
| `src/store.js` | Datenhaltung (Firebase oder Demo-Modus) |
| `src/scanner.js` | Kamera und Barcode-Erkennung |
| `src/lookup.js` | Produktnamen aus Open Food Facts |
| `config.js` | Firebase-Verbindung (leer = Demo-Modus) |
| `firestore.rules` | Zugriffsregeln für die Datenbank |

## Entwickeln

```sh
npm install
npm run build      # baut nach dist/
npm run dev        # baut und startet einen lokalen Server
```

Jeder Push auf `main` baut die App und veröffentlicht sie über GitHub Pages.
