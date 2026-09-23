# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Uses [uv](https://docs.astral.sh/uv/) (Python ≥ 3.11).

```bash
uv run walkie-server                  # HTTPS + WSS on https://<lan-ip>:8765/ (prints the URLs)
uv run walkie-server --port 9000      # other port; also --host, --no-tls
uv run pytest                         # all tests
uv run pytest tests/test_mqtt.py::test_publish_subscribe_and_will   # single test
```

Settings can also come from `WALKIE_*` env vars (`server/walkie_server/settings.py`). `--no-tls` serves plain HTTP/WS, where browsers only grant the microphone on `localhost`. There is no linter configured and the client has no build step.

## Architecture

The project has two independent halves that meet only over MQTT:

- **`docs/`: static browser client** (plain ES modules, no bundler). It is also the GitHub Pages root, so it must stay deployable as-is and must work against **any** public MQTT-over-WSS broker (default `wss://broker.emqx.io:8084/mqtt`). Don't rely on features only the local broker has. `vendor/mqtt.min.js` is loaded as a classic script and exposes the global `mqtt` used by `radio.js`.
- **`server/walkie_server/`: optional LAN server.** A single `websockets` server on one port: `app.py`'s `process_request` hook serves static files from `docs/` for normal HTTP requests and lets only WebSocket upgrades on `/mqtt` through to the broker.

### Broker config handoff
`docs/config.json` (`broker`, `prefix`) is used only on GitHub Pages. The LAN server never serves that file. `StaticSite` returns a synthetic `{"broker": "same-origin:/mqtt"}` instead, and `app.js` `loadConfig()` turns `same-origin:` into `ws(s)://<location.host>/mqtt`. The `?broker=` and `?prefix=` query params override both.

### Minimal MQTT broker (`server/walkie_server/mqtt/`)
- `codec.py`: MQTT 3.1.1 wire format (incremental `FrameReader`, decoders, encoders); `topics.py`: pure filter matching; `broker.py`: routing.
- `Broker` is transport-agnostic through the `Transport` protocol (`recv`/`send`/`close`/`remote`). `app.WebSocketTransport` is the only adapter. Tests drive it over a real WebSocket on port 0.
- Intentional limits: inbound QoS 1 is PUBACKed but delivery is always QoS 0; QoS 2 is rejected; there are no retained messages and no persistent sessions. Each session has a bounded outbox (`OUTBOX_LIMIT`), and a client that falls behind is disconnected. A reconnect with the same client id drops the old connection **and suppresses its will**. The will is published only on non-graceful disconnect.

### Radio protocol (client side, `docs/js/radio.js`)
The topic layout is documented in the header of `radio.js`, under a versioned prefix (`webwalkie/v2`, also `DEFAULT_PREFIX` in `app.js` and `docs/config.json`). Bump the version in all three places if the wire format changes, since old clients on public brokers share the same topics.
- `<prefix>/presence`: JSON heartbeat every 5 s, TTL 16 s. Every client subscribes to all presence messages so peer counts per channel update live. The MQTT Last Will publishes `{on:false}`.
- `<prefix>/ch/<n>/floor`: floor control. Requests arriving within a 400 ms contention window are candidates, and the **lowest id wins**. The result must stay deterministic on every client even when a clustered broker reorders messages. Transmissions are capped at 60 s (`MAX_TX_MS`).
- `<prefix>/ch/<n>/ring`: "trillo", JSON `{id}`. It plays a ring on every radio tuned to the channel. The sender allows one per `RING_COOLDOWN_MS` (60 s), and the cooldown is persisted in `localStorage` by `app.js`. Receivers also drop repeats from the same id. The topic was added without a version bump: old clients ignore unknown `ch/<n>/…` subtopics.
- `<prefix>/ch/<n>/audio/<id>`: binary IMA ADPCM packets, 8 kHz, ~100 ms each. Each packet carries a 4-byte codec-state header (`adpcm.js`) so it can be decoded on its own after loss or a mid-transmission tune-in.

Audio pipeline: `audio.js` (`AudioEngine`: capture, jitter-buffered playback, squelch/radio effects) → `capture-worklet.js` (300–3000 Hz band-pass, soft clip, resample to 8 kHz) → `adpcm.js`. `app.js` holds the UI, the PTT handling and the wiring between `Radio` events (`audio`, `rx-start`, `tx-granted`, …) and `AudioEngine`.

### TLS
The microphone requires HTTPS off `localhost`. `tls.py` keeps a self-signed EC cert in `.certs/` (gitignored) and regenerates it when the current LAN IPs aren't all in its SAN or it is about to expire.

## Conventions
- User-facing text is in **Italian**: UI strings, server log messages, CLI help and README. Code, identifiers and comments are in English.
- Python docstrings use reST fields (`:param type name:`, `:return:`, `:rtype:`, `:raises:`), and dataclasses are typically `frozen=True, slots=True`.
- pytest runs with `asyncio_mode = "auto"`, so async tests need no marker.
