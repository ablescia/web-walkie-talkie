# Web Walkie-Talkie

Walkie-talkie nel browser (mobile e desktop): scegli una **frequenza** (canale 1–99),
vedi quante persone sono sintonizzate e **tieni premuto per parlare**. Parla una sola
persona alla volta, come su una radio vera.

## Come funziona

```
 browser A ─┐                                   ┌─ browser B
            │   MQTT su WebSocket (wss://)      │
            └────────►  broker MQTT  ◄──────────┘
                     (locale o pubblico)
```

- **Frequenza = channel name.** Il canale N corrisponde ai topic `webwalkie/v2/ch/N/…`.
  La frequenza mostrata (446.00625 MHz + passo 12,5 kHz) è solo estetica.
- **Interlocutori.** Ogni radio accesa annuncia `{id, canale}` sul topic di presenza
  ogni 5 s. Tutti ascoltano tutte le presenze, quindi mentre giri lo spinner il numero di
  persone su quel canale si aggiorna all'istante. Il *Last Will* MQTT rimuove chi si
  disconnette all'improvviso.
- **Una sola persona alla volta.** Premendo il PTT si pubblica una richiesta sul canale.
  Tutte le richieste arrivate entro 400 ms sono candidate e vince l'id più basso. Ogni
  client calcola lo stesso vincitore, anche quando il broker è un cluster che consegna i
  messaggi in ordine diverso. Chi preme mentre un altro parla sente il tono di occupato.
  Una trasmissione dura al massimo 60 s.
- **Trillo.** Il tasto 🔔 fa suonare tutte le radio sintonizzate sul tuo canale (e vibrare i
  telefoni), anche mentre qualcuno parla. Si può usare una volta al minuto: il limite vale
  anche se spegni la radio o ricarichi la pagina, e chi riceve ignora comunque i trilli
  troppo ravvicinati dello stesso mittente.
- **Audio.** Microfono → AudioWorklet (banda 300–3000 Hz, saturazione morbida) → 8 kHz,
  IMA ADPCM 4 bit (32 kbit/s, ~4 kB/s) → pacchetti da 100 ms, ognuno decodificabile da
  solo → buffer anti-jitter, altoparlante "radio" e fruscio di portante in ricezione.

Il client (`docs/`) è **solo statico**: HTML, CSS e JS senza build. Per questo può essere
pubblicato così com'è su GitHub Pages.

## Avvio in locale (LAN)

Serve [uv](https://docs.astral.sh/uv/) (Python ≥ 3.11).

```bash
uv run walkie-server              # HTTPS + WSS su https://<ip-lan>:8765/
uv run walkie-server --port 9000  # altra porta
```

Il server Python fa due cose sulla stessa porta:
1. serve i file di `docs/`;
2. fa da broker MQTT-su-WebSocket (`/mqtt`). È un broker minimale scritto in
   `server/walkie_server/mqtt/`, e in LAN non serve Internet.

Apri l'URL stampato all'avvio (es. `https://192.168.1.50:8765/`) su due o più dispositivi
della stessa rete.

> **Certificato:** il server genera un certificato autofirmato in `.certs/`. Al primo
> accesso il browser mostra un avviso: scegli *Avanzate → Procedi*. HTTPS è obbligatorio
> perché i browser concedono il microfono solo su HTTPS o su `localhost`.

Test del server: `uv run pytest`.

## Pubblicazione su GitHub Pages

1. Crea il repository e fai push di questa cartella.
2. **Settings → Pages → Build and deployment:** *Deploy from a branch*, branch `main`,
   cartella **`/docs`**.
3. Apri `https://<utente>.github.io/<repo>/`.

Su GitHub Pages non c'è un server. Il client usa il broker indicato in `docs/config.json`:
di default il broker pubblico gratuito `wss://broker.emqx.io:8084/mqtt`.
Il server locale invece restituisce un proprio `config.json` che punta a se stesso.

- **Canali privati:** su un broker pubblico chiunque usi lo stesso prefisso può ascoltare,
  proprio come una radio vera. Per un gruppo riservato cambia `prefix` in
  `docs/config.json` (es. `"webwalkie/famiglia-rossi-7f3a"`).
- **Altro broker:** qualunque broker MQTT con WebSocket su TLS (Mosquitto, EMQX,
  HiveMQ…). Puoi cambiarlo in `config.json` oppure al volo con `?broker=wss://host:porta/mqtt`.

## Uso

- **⏻** accende e spegne. Al primo tocco il browser sblocca l'audio.
- **‹ ›** oppure rotella o frecce: cambia frequenza. Tieni premuto per scorrere velocemente.
- **PTT** (o barra spaziatrice sul desktop): tieni premuto per parlare. Dopo il doppio
  beep sei in onda; al rilascio parte il "roger beep".
- **🔔** fa trillare tutte le radio sul canale. Durante l'attesa mostra i secondi mancanti.

Note: su iPhone l'interruttore silenzioso azzera l'audio web. Lo schermo resta acceso
(Wake Lock) finché la radio è accesa, perché con lo schermo spento il browser sospende la
connessione.

## Struttura

```
docs/                     client statico (radice di GitHub Pages)
  index.html, style.css
  config.json             broker + prefisso usati su GitHub Pages
  js/app.js               interfaccia e PTT
  js/radio.js             presenza, arbitraggio del canale, topic MQTT
  js/audio.js             cattura, riproduzione, effetti
  js/capture-worklet.js   filtro radio + ricampionamento a 8 kHz
  js/adpcm.js             codec IMA ADPCM (4 bit, 32 kbit/s)
  vendor/mqtt.min.js      mqtt.js 5.16.0 (MIT)
server/walkie_server/     server LAN (Python)
  mqtt/                   broker MQTT 3.1.1 minimale (QoS 0/1, will, wildcard)
  app.py                  HTTPS statico + WebSocket sulla stessa porta
  tls.py                  certificato autofirmato
tests/                    test del broker e del server
```
