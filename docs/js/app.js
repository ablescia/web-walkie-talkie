import { AudioEngine } from "./audio.js";
import { CHANNEL_MAX, CHANNEL_MIN, MAX_TX_MS, RING_COOLDOWN_MS, Radio, frequencyOf } from "./radio.js";

const DEFAULT_PREFIX = "webwalkie/v2";
const PRE_GRANT_BUFFER = 30; // chunks (~3 s) recorded while waiting for the floor

// Lock-screen artwork: the favicon on a dark tile (rendered to PNG, see makeArtwork).
const ARTWORK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" fill="#131517"/><g transform="translate(4 2.5) scale(0.85)">' +
  '<rect x="9" y="7" width="14" height="23" rx="3" fill="#ff6b1a"/><rect x="11" y="1" width="3" height="8" rx="1.5" fill="#ff6b1a"/>' +
  '<rect x="12" y="10" width="8" height="5" rx="1" fill="#c8dc8a"/></g></svg>';

const $ = (id) => document.getElementById(id);
const ui = {
  radio: $("radio"),
  power: $("power"),
  ring: $("ring"),
  ringWait: $("ring-wait"),
  net: $("net"),
  mode: $("mode"),
  channel: $("channel"),
  chnum: $("chnum"),
  freq: $("freq"),
  people: $("people"),
  status: $("status"),
  ptt: $("ptt"),
  pttLabel: $("ptt-label"),
  hint: $("hint"),
  steps: document.querySelectorAll(".step"),
};

const storage = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: ignore */
    }
  },
};

const audio = new AudioEngine();
let radio = null;
let powering = false; // powerOn() in progress (guards against double taps)
let config = null;
let channel = clampChannel(Number(storage.get("wt.channel", "1")));
let pressed = false;
let pending = [];
let flash = null; // {text, until}
let wakeLock = null;
let webLock = null; // {release?}: Web Lock held while the radio is on, see holdWebLock()
let ringAt = Number(storage.get("wt.ringAt", "0")) || 0; // last ring we sent (survives reloads)
let ringTimer = null; // redraws the cooldown countdown
let ringingTimer = null; // ends the "ringing" animation
let artwork = []; // MediaMetadata artwork, filled by makeArtwork()
let sessionKey = ""; // media session metadata currently shown, to avoid needless updates
let sessionState = ""; // media session playbackState currently set

// ------------------------------------------------------------------ setup

function clampChannel(n) {
  return Number.isInteger(n) ? Math.min(CHANNEL_MAX, Math.max(CHANNEL_MIN, n)) : CHANNEL_MIN;
}

async function loadConfig() {
  let file = {};
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (res.ok) file = await res.json();
  } catch {
    /* offline or missing: fall back to defaults */
  }
  const params = new URLSearchParams(location.search);
  let broker = params.get("broker") || file.broker || "wss://broker.emqx.io:8084/mqtt";
  if (broker.startsWith("same-origin:")) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    broker = `${scheme}://${location.host}${broker.slice("same-origin:".length)}`;
  }
  return { broker, prefix: params.get("prefix") || file.prefix || DEFAULT_PREFIX };
}

// ------------------------------------------------------------------ power

async function powerOn() {
  if (radio || powering) return;
  powering = true;
  try {
    audio.init(); // synchronously: the audio must start while the tap is being processed
    config ??= await loadConfig();
  } catch (err) {
    console.error(err);
    audio.standby();
    showFlash("AUDIO NON DISPONIBILE");
    return;
  } finally {
    powering = false;
  }
  radio = new Radio({ brokerUrl: config.broker, prefix: config.prefix, channel });
  radio.addEventListener("change", render);
  radio.addEventListener("audio", (e) => audio.play(e.detail));
  radio.addEventListener("rx-start", () => {
    audio.resetPlayback();
    audio.squelchOpen();
  });
  radio.addEventListener("rx-end", () => audio.squelchTail());
  radio.addEventListener("tx-granted", onGranted);
  radio.addEventListener("tx-denied", onDenied);
  radio.addEventListener("ring", (e) => onRing(e.detail.self));
  radio.addEventListener("tx-end", (e) => {
    pending = [];
    audio.stopCapture();
    if (pressed && e.detail.granted) {
      audio.rogerBeep();
      showFlash("TEMPO SCADUTO");
    }
  });
  radio.connect();
  requestWakeLock();
  holdWebLock();
  render();
}

function powerOff() {
  if (!radio) return;
  pressed = false;
  radio.disconnect();
  radio = null;
  audio.standby();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  releaseWebLock();
  render();
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}

/** Chrome does not freeze (or discard) a hidden page that holds a Web Lock. Shared: every open radio holds it. */
function holdWebLock() {
  if (webLock || !navigator.locks) return;
  const held = {};
  webLock = held;
  navigator.locks
    .request("webwalkie-radio", { mode: "shared" }, () => new Promise((resolve) => (webLock === held ? (held.release = resolve) : resolve())))
    .catch(() => {});
}

function releaseWebLock() {
  webLock?.release?.();
  webLock = null;
}

/**
 * Back in the foreground, or back online: the browser may have paused the
 * audio and let the socket die while we were not looking.
 */
function wake() {
  if (!radio) return;
  audio.resume();
  radio.wake();
  requestWakeLock();
}

// ------------------------------------------------------------------ media session

// The keep-alive track (audio.js) puts the radio on the lock screen and in the
// media notification: show the channel there and map its buttons to the power switch.
function setupMediaSession() {
  const session = navigator.mediaSession;
  if (!session) return;
  const handlers = { play: () => powerOn(), pause: () => powerOff(), stop: () => powerOff() };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      /* action not supported here */
    }
  }
  makeArtwork();
}

function makeArtwork() {
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      canvas.getContext("2d").drawImage(img, 0, 0, 256, 256);
      artwork = [{ src: canvas.toDataURL("image/png"), sizes: "256x256", type: "image/png" }];
      sessionKey = "";
      render();
    } catch {
      /* no artwork, no harm */
    }
  };
  img.src = `data:image/svg+xml,${encodeURIComponent(ARTWORK_SVG)}`;
}

function updateMediaSession(state) {
  const session = navigator.mediaSession;
  if (!session) return;
  const playback = radio ? "playing" : "paused";
  if (playback !== sessionState) {
    sessionState = playback;
    session.playbackState = playback;
  }
  const title = `Canale ${String(channel).padStart(2, "0")} · ${frequencyOf(channel)} MHz`;
  const artist = {
    off: "Spento",
    connecting: "Connessione…",
    pending: "In trasmissione",
    tx: "In trasmissione",
    rx: "In ricezione",
  }[state] ?? "Canale libero";
  const key = `${title}|${artist}|${artwork.length}`;
  if (key === sessionKey) return;
  sessionKey = key;
  try {
    session.metadata = new MediaMetadata({ title, artist, album: "Walkie-Talkie", artwork });
  } catch (err) {
    console.warn("[app] media session", err);
  }
}

// ------------------------------------------------------------------ push-to-talk

async function pttDown() {
  if (!radio) return powerOn();
  if (pressed) return;
  pressed = true;
  ui.ptt.classList.add("pressed");
  audio.resume();

  const result = radio.requestTalk();
  if (result !== "ok") {
    pressed = false;
    ui.ptt.classList.remove("pressed");
    const text = { busy: "CANALE OCCUPATO", tuning: "SINTONIZZAZIONE…", offline: "NON CONNESSO" }[result];
    showFlash(text);
    if (result === "busy") refuse();
    return;
  }

  pending = [];
  try {
    await audio.startCapture((chunk) => {
      if (radio?.tx === "on") radio.sendAudio(chunk);
      else if (radio?.tx === "pending" && pending.length < PRE_GRANT_BUFFER) pending.push(chunk);
    });
  } catch (err) {
    console.warn(err);
    radio?.releaseTalk();
    pressed = false;
    ui.ptt.classList.remove("pressed");
    showFlash(micErrorText(err));
    refuse();
    return;
  }
  if (!pressed) pttUp(true);
}

function micErrorText(err) {
  if (!audio.micSupported) return "MICROFONO: SERVE HTTPS";
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") return "MICROFONO NEGATO";
  return "MICROFONO NON DISPONIBILE";
}

function pttUp(force = false) {
  if (!pressed && !force) return;
  pressed = false;
  ui.ptt.classList.remove("pressed");
  if (!radio) return;
  if (radio.tx === "on") audio.rogerBeep();
  radio.releaseTalk();
  audio.stopCapture();
}

function onGranted() {
  audio.grantBeep();
  navigator.vibrate?.(30);
  pending.forEach((chunk) => radio.sendAudio(chunk));
  pending = [];
  if (!pressed) pttUp(true);
}

function onDenied() {
  pending = [];
  audio.stopCapture();
  showFlash("CANALE OCCUPATO");
  refuse();
}

function refuse() {
  audio.busyTone();
  navigator.vibrate?.([60, 60, 60]);
}

// ------------------------------------------------------------------ ringing

/** Milliseconds before we may ring again. */
function ringCooldown() {
  const left = ringAt + RING_COOLDOWN_MS - Date.now();
  return left > RING_COOLDOWN_MS ? 0 : Math.max(0, left); // clock moved back: don't lock forever
}

function sendRing() {
  if (!radio || radio.status !== "online") return;
  const left = ringCooldown();
  if (left > 0) {
    showFlash(`TRILLO TRA ${Math.ceil(left / 1000)}s`);
    refuse();
    return;
  }
  audio.resume();
  if (!radio.ring()) return;
  ringAt = Date.now();
  storage.set("wt.ringAt", String(ringAt));
  startRingCountdown();
  render();
}

function startRingCountdown() {
  clearInterval(ringTimer);
  if (ringCooldown() === 0) return;
  ringTimer = setInterval(() => {
    if (ringCooldown() === 0) clearInterval(ringTimer);
    render();
  }, 1000);
}

function onRing(self) {
  audio.ring();
  navigator.vibrate?.([180, 70, 180, 70, 180]);
  showFlash(self ? "TRILLO INVIATO" : "TRILLO!");
  ui.radio.classList.add("ringing");
  clearTimeout(ringingTimer);
  ringingTimer = setTimeout(() => ui.radio.classList.remove("ringing"), 1200);
}

// ------------------------------------------------------------------ channel

function stepChannel(delta) {
  setChannel(channel + delta > CHANNEL_MAX ? CHANNEL_MIN : channel + delta < CHANNEL_MIN ? CHANNEL_MAX : channel + delta);
}

function setChannel(next) {
  if (radio && radio.tx !== "idle") return;
  if (radio?.talker) audio.resetPlayback();
  channel = next;
  storage.set("wt.channel", String(channel));
  radio?.setChannel(channel);
  render();
}

// ------------------------------------------------------------------ rendering

function showFlash(text) {
  flash = { text, until: Date.now() + 2200 };
  ui.status.classList.remove("flash");
  void ui.status.offsetWidth; // restart the animation
  ui.status.classList.add("flash");
  render();
  setTimeout(render, 2300);
}

function peopleLabel(n) {
  if (n === 0) return "Nessuno in ascolto";
  return n === 1 ? "1 interlocutore" : `${n} interlocutori`;
}

function stateOf() {
  if (!radio) return "off";
  if (radio.status !== "online") return "connecting";
  if (radio.tx === "on") return "tx";
  if (radio.tx === "pending") return "pending";
  if (radio.talker) return "rx";
  return "idle";
}

function render() {
  const state = stateOf();
  ui.radio.dataset.state = state;

  ui.chnum.textContent = String(channel).padStart(2, "0");
  ui.freq.textContent = frequencyOf(channel);
  ui.channel.setAttribute("aria-valuenow", String(channel));
  ui.channel.setAttribute("aria-valuetext", `Canale ${channel}, ${frequencyOf(channel)} megahertz`);
  const locked = state === "tx" || state === "pending";
  ui.steps.forEach((b) => (b.disabled = !radio || locked));

  const ringLeft = ringCooldown();
  ui.ring.disabled = radio?.status !== "online";
  ui.ring.classList.toggle("waiting", ringLeft > 0);
  ui.ringWait.textContent = ringLeft > 0 ? String(Math.ceil(ringLeft / 1000)) : "";
  ui.ring.title = ringLeft > 0 ? `Trillo disponibile tra ${Math.ceil(ringLeft / 1000)} s` : "Trillo";

  ui.net.textContent = { off: "SPENTO", connecting: "CONNESSIONE…" }[state] ?? "● ONLINE";
  ui.mode.textContent = state === "tx" ? "TX" : state === "rx" ? "RX" : "";
  ui.people.textContent = radio?.status === "online" ? peopleLabel(radio.countOn(channel)) : "—";

  let status;
  if (flash && Date.now() < flash.until) status = flash.text;
  else if (state === "off") status = "SPENTO";
  else if (state === "connecting") status = "CONNESSIONE…";
  else if (state === "tx") {
    const left = Math.max(0, Math.ceil((MAX_TX_MS - (Date.now() - radio.txSince)) / 1000));
    status = left <= 10 ? `IN TRASMISSIONE · ${left}s` : "IN TRASMISSIONE";
  } else if (state === "pending") status = "ATTENDI…";
  else if (state === "rx") status = "IN RICEZIONE";
  else status = "CANALE LIBERO";
  ui.status.textContent = status;

  ui.pttLabel.textContent = { off: "ACCENDI", tx: "PARLA", rx: "OCCUPATO", connecting: "…" }[state] ?? "PTT";
  ui.hint.textContent = {
    off: "Tocca per accendere",
    tx: "Rilascia per passare",
    rx: "Qualcuno sta parlando",
    connecting: "Connessione al server…",
  }[state] ?? (matchMedia("(hover: hover)").matches ? "Tieni premuto per parlare (o barra spaziatrice)" : "Tieni premuto per parlare");

  updateMediaSession(state);
}

// ------------------------------------------------------------------ events

// While off, the tap's "click" powers on: on iOS a touch "pointerdown" is not a
// user activation for audio, so the AudioContext could not start from it.
ui.ptt.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !radio) return;
  e.preventDefault();
  ui.ptt.setPointerCapture?.(e.pointerId);
  pttDown();
});
ui.ptt.addEventListener("click", () => {
  if (!radio) powerOn();
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => ui.ptt.addEventListener(type, () => pttUp()));
ui.ptt.addEventListener("contextmenu", (e) => e.preventDefault());
ui.ptt.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
    e.preventDefault();
    pttDown();
  }
});
ui.ptt.addEventListener("keyup", (e) => {
  if (e.key === "Enter" || e.key === " ") pttUp();
});

ui.power.addEventListener("click", () => {
  ui.power.blur(); // keep the space bar free for push-to-talk
  radio ? powerOff() : powerOn();
});

ui.ring.addEventListener("click", () => {
  ui.ring.blur(); // keep the space bar free for push-to-talk
  sendRing();
});

// Spinner buttons: click steps once, holding repeats.
ui.steps.forEach((button) => {
  let repeat = null;
  const stop = () => {
    clearTimeout(repeat);
    clearInterval(repeat);
  };
  button.addEventListener("pointerdown", (e) => {
    if (button.disabled) return;
    e.preventDefault();
    const delta = Number(button.dataset.step);
    stepChannel(delta);
    repeat = setTimeout(() => (repeat = setInterval(() => stepChannel(delta), 90)), 420);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((type) => button.addEventListener(type, stop));
  button.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      stepChannel(Number(button.dataset.step));
    }
  });
});

let wheelAcc = 0;
ui.channel.parentElement.addEventListener(
  "wheel",
  (e) => {
    if (!radio) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) >= 40) {
      stepChannel(wheelAcc < 0 ? 1 : -1);
      wheelAcc = 0;
    }
  },
  { passive: false },
);

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, button")) return;
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    pttDown();
  } else if (radio && (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "+")) {
    e.preventDefault();
    stepChannel(1);
  } else if (radio && (e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "-")) {
    e.preventDefault();
    stepChannel(-1);
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") pttUp();
});

window.addEventListener("blur", () => pttUp());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Nobody can hold the button with the screen off; drop the mic too, since
    // iOS mutes it in the background and may leave it that way.
    pttUp();
    audio.closeMic();
  } else {
    wake();
  }
});
document.addEventListener("resume", wake); // Page Lifecycle: Chrome thawed a frozen page
window.addEventListener("online", wake);
window.addEventListener("pagehide", () => powerOff());

setupMediaSession();
startRingCountdown();
render();
