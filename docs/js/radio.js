// Radio logic on top of MQTT-over-WebSocket: presence per channel and
// "one talker at a time" floor control.
//
// Topics (prefix = config.prefix):
//   <prefix>/presence               JSON {id, ch, on, hello?}   everybody, every channel
//   <prefix>/ch/<n>/floor           JSON {id, op: "req"|"rel"}  floor requests/releases
//   <prefix>/ch/<n>/audio/<id>      binary IMA ADPCM 8 kHz packets (see adpcm.js)
//   <prefix>/ch/<n>/ring            JSON {id}                   "trillo": rings every radio on the channel
//
// Floor arbitration: the first "req" seen on a free channel opens a short
// contention window; every "req" received within it is a candidate and the
// lowest id wins. Each client (requesters included) computes the same winner,
// even when a clustered broker delivers concurrent requests in different orders.
//
// Rings are limited to one per RING_COOLDOWN_MS by the sender; receivers also
// drop rings that come too soon from the same id.
//
// Liveness: we are subscribed to the presence topic, so the broker echoes our
// own heartbeats back to us. When the echo stops (ECHO_TIMEOUT_MS) the
// connection is dead even if the socket still looks open, as happens after the
// phone comes back from standby, and we open a new one: connecting again with
// the same client id makes the broker drop the stale session. All timers run
// through timers.js so they keep their pace while the page is in the background.

import { timers } from "./timers.js";

export const CHANNEL_MIN = 1;
export const CHANNEL_MAX = 99;

const HEARTBEAT_MS = 5000;
const PRESENCE_TTL_MS = 16000;
const ECHO_TIMEOUT_MS = 15000; // three heartbeats without hearing ourselves: reconnect
const PROBE_TIMEOUT_MS = 4000; // same, for the heartbeat sent when the page wakes up
const FLOOR_TIMEOUT_MS = 2000;
const GRANT_TIMEOUT_MS = 3000;
const CONTENTION_MS = 400;
const TUNING_MS = 700; // listen a moment after tuning to detect an ongoing transmission
export const MAX_TX_MS = 60000;
export const RING_COOLDOWN_MS = 60000;
const RING_SLACK_MS = 5000; // receivers tolerate some delivery jitter on the cooldown

export function frequencyOf(channel) {
  return (446.00625 + (channel - 1) * 0.0125).toFixed(5);
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const textDecoder = new TextDecoder();

export class Radio extends EventTarget {
  constructor({ brokerUrl, prefix, channel }) {
    super();
    this.brokerUrl = brokerUrl;
    this.prefix = prefix;
    this.channel = channel;
    this.id = randomId();
    this.status = "offline"; // offline | connecting | online
    this.peers = new Map(); // id -> {ch, seen}
    this.floor = null; // {id, last, settled, contenders}: who holds the channel (may be us)
    this.tx = "idle"; // idle | pending | on
    this.txSince = 0;
    this.tunedAt = 0;
    this.client = null;
    this.timers = [];
    this.helloReply = null;
    this.presenceDebounce = null;
    this.settleTimer = null;
    this.rings = new Map(); // id -> when we last accepted a ring from it
    this.echoAt = 0; // when the broker last echoed one of our own presence messages
    this.probeAt = 0; // when wake() sent a heartbeat that is still waiting for its echo
  }

  // ---------------------------------------------------------------- lifecycle

  connect() {
    this.status = "connecting";
    this.emit("change");
    this.openClient();
    this.timers.push(timers.setInterval(() => this.announce(false), HEARTBEAT_MS));
    this.timers.push(timers.setInterval(() => this.tick(), 250));
  }

  disconnect() {
    this.releaseTalk();
    this.timers.forEach(timers.clear);
    this.timers = [];
    timers.clear(this.helloReply);
    timers.clear(this.presenceDebounce);
    if (this.client) {
      if (this.client.connected) this.publishJson(this.topic("presence"), { id: this.id, on: false });
      this.client.end(false);
      this.client = null;
    }
    this.peers.clear();
    this.rings.clear();
    this.clearFloor();
    this.status = "offline";
    this.emit("change");
  }

  /** Opens the MQTT connection. Handlers ignore events from a client that has been replaced. */
  openClient() {
    const client = mqtt.connect(this.brokerUrl, {
      clientId: `wt-${this.id}`,
      protocolVersion: 4,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
      will: {
        topic: this.topic("presence"),
        payload: JSON.stringify({ id: this.id, on: false }),
        qos: 0,
        retain: false,
      },
    });
    this.client = client;
    const current = (handler) => (...args) => this.client === client && handler(...args);
    client.on(
      "connect",
      current(() => {
        this.status = "online";
        this.tunedAt = Date.now();
        this.echoAt = Date.now();
        this.probeAt = 0;
        client.subscribe([this.topic("presence"), this.channelTopic(this.channel, "#")]);
        this.announce(true);
        this.emit("change");
      }),
    );
    client.on("reconnect", current(() => this.setStatus("connecting")));
    client.on("offline", current(() => this.setStatus("connecting")));
    client.on("error", (err) => console.warn("[radio] mqtt error", err));
    client.on("message", current((topic, payload) => this.onMessage(topic, payload)));
  }

  /** Drops a connection that stopped echoing us and opens a fresh one with the same id. */
  reconnect() {
    const stale = this.client;
    if (!stale) return;
    console.warn("[radio] no echo from the broker, reconnecting");
    this.setStatus("connecting");
    stale.end(true);
    this.openClient();
  }

  /**
   * The page is back in the foreground (or the network is back): the socket may
   * be dead without anybody having noticed. Send a heartbeat right away and let
   * tick() reconnect unless its echo arrives within PROBE_TIMEOUT_MS.
   */
  wake() {
    if (this.status !== "online" || this.probeAt) return;
    this.probeAt = Date.now();
    this.announce(false);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    if (status !== "online") {
      this.releaseTalk();
      this.clearFloor();
    }
    this.emit("change");
  }

  // ---------------------------------------------------------------- settings

  setChannel(channel) {
    if (channel === this.channel || this.tx !== "idle") return false;
    const previous = this.channel;
    this.channel = channel;
    this.clearFloor();
    this.tunedAt = Date.now();
    if (this.client) {
      this.client.unsubscribe(this.channelTopic(previous, "#"));
      this.client.subscribe(this.channelTopic(channel, "#"));
      timers.clear(this.presenceDebounce);
      this.presenceDebounce = timers.setTimeout(() => this.announce(false), 150);
    }
    this.emit("change");
    return true;
  }

  /** Number of other people tuned on `channel`. */
  countOn(channel) {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.ch === channel) count++;
    return count;
  }

  // ---------------------------------------------------------------- talking

  /** Ask for the floor. Returns "ok", or why it can't be done right now. */
  requestTalk() {
    if (this.status !== "online") return "offline";
    if (this.tx !== "idle") return "ok";
    if (this.talker) return "busy";
    if (Date.now() - this.tunedAt < TUNING_MS) return "tuning";
    this.tx = "pending";
    this.txSince = Date.now();
    this.publishJson(this.channelTopic(this.channel, "floor"), { id: this.id, op: "req" });
    this.emit("change");
    return "ok";
  }

  releaseTalk() {
    if (this.tx === "idle") return;
    const wasOn = this.tx === "on";
    this.tx = "idle";
    if (this.client?.connected) {
      this.publishJson(this.channelTopic(this.channel, "floor"), { id: this.id, op: "rel" });
    }
    this.withdraw(this.id);
    this.emit("tx-end", { granted: wasOn });
    this.emit("change");
  }

  sendAudio(chunk) {
    if (this.tx !== "on" || !this.client?.connected) return;
    this.client.publish(this.channelTopic(this.channel, `audio/${this.id}`), chunk, { qos: 0 });
  }

  // ---------------------------------------------------------------- ringing

  /** Ring every radio on the current channel (us included, via a local "ring" event). */
  ring() {
    if (this.status !== "online") return false;
    this.publishJson(this.channelTopic(this.channel, "ring"), { id: this.id });
    this.emit("ring", { self: true });
    return true;
  }

  // ---------------------------------------------------------------- internals

  topic(suffix) {
    return `${this.prefix}/${suffix}`;
  }

  channelTopic(channel, suffix) {
    return `${this.prefix}/ch/${channel}/${suffix}`;
  }

  publishJson(topic, obj) {
    this.client?.publish(topic, JSON.stringify(obj), { qos: 0 });
  }

  announce(hello) {
    if (!this.client?.connected) return;
    const msg = { id: this.id, ch: this.channel, on: true };
    if (hello) msg.hello = true;
    this.publishJson(this.topic("presence"), msg);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  onMessage(topic, payload) {
    const prefix = `${this.prefix}/`;
    if (!topic.startsWith(prefix)) return;
    const parts = topic.slice(prefix.length).split("/");
    if (parts[0] === "presence") return this.onPresence(this.parseJson(payload));
    if (parts[0] !== "ch" || Number(parts[1]) !== this.channel) return;
    if (parts[2] === "floor") return this.onFloor(this.parseJson(payload));
    if (parts[2] === "audio" && parts[3]) return this.onAudio(parts[3], payload);
    if (parts[2] === "ring") return this.onRing(this.parseJson(payload));
  }

  parseJson(payload) {
    try {
      return JSON.parse(textDecoder.decode(payload));
    } catch {
      return null;
    }
  }

  onPresence(msg) {
    if (!msg || typeof msg.id !== "string") return;
    if (msg.id === this.id) {
      // Our own message coming back: proof that the connection is alive.
      this.echoAt = Date.now();
      this.probeAt = 0;
      return;
    }
    if (!msg.on) {
      this.peers.delete(msg.id);
      this.withdraw(msg.id);
    } else {
      const ch = Number(msg.ch);
      if (!Number.isInteger(ch)) return;
      this.peers.set(msg.id, { ch, seen: Date.now() });
      if (msg.hello) {
        // A newcomer asks who's around: answer after a random delay to avoid bursts.
        timers.clear(this.helloReply);
        this.helloReply = timers.setTimeout(() => this.announce(false), 100 + Math.random() * 600);
      }
    }
    this.emit("change");
  }

  onFloor(msg) {
    if (!msg || typeof msg.id !== "string") return;
    if (msg.op === "req") {
      if (!this.floor) {
        // Channel was free: open a contention window.
        this.floor = { id: msg.id, last: Date.now(), settled: false, contenders: new Set([msg.id]) };
        timers.clear(this.settleTimer);
        this.settleTimer = timers.setTimeout(() => this.settle(), CONTENTION_MS);
      } else if (!this.floor.settled) {
        this.floor.contenders.add(msg.id);
        this.pickWinner();
      } else if (msg.id === this.id && this.floor.id !== this.id && this.tx === "pending") {
        this.denied();
      }
    } else if (msg.op === "rel" && msg.id !== this.id) {
      this.withdraw(msg.id);
    }
    this.emit("change");
  }

  /** Deterministic winner: lowest id among the requests seen in the window. */
  pickWinner() {
    this.floor.id = [...this.floor.contenders].sort()[0];
  }

  settle() {
    const floor = this.floor;
    if (!floor || floor.settled) return;
    floor.settled = true;
    floor.last = Date.now();
    if (floor.id === this.id) {
      if (this.tx === "pending") {
        this.tx = "on";
        this.txSince = Date.now();
        this.emit("tx-granted");
      } else {
        this.floor = null; // we won but already let go
      }
    } else {
      if (this.tx === "pending") this.denied();
      this.emit("rx-start");
    }
    this.emit("change");
  }

  /** `id` released (or gave up) the floor. */
  withdraw(id) {
    const floor = this.floor;
    if (!floor) return;
    if (!floor.settled) {
      floor.contenders.delete(id);
      if (floor.contenders.size === 0) {
        timers.clear(this.settleTimer);
        this.floor = null;
      } else {
        this.pickWinner();
      }
    } else if (floor.id === id) {
      this.clearFloor();
    }
  }

  /** Somebody else is transmitting (floor settled on another id). */
  get talker() {
    return this.floor?.settled && this.floor.id !== this.id ? this.floor : null;
  }

  onAudio(senderId, payload) {
    if (senderId === this.id) return;
    if (!this.floor) {
      // We tuned in while somebody was already talking.
      this.floor = { id: senderId, last: Date.now(), settled: true, contenders: new Set() };
      this.emit("rx-start");
      this.emit("change");
    }
    if (!this.floor.settled || this.floor.id !== senderId) return;
    this.floor.last = Date.now();
    this.emit("audio", payload);
  }

  onRing(msg) {
    if (!msg || typeof msg.id !== "string" || msg.id === this.id) return;
    const now = Date.now();
    const last = this.rings.get(msg.id);
    if (last !== undefined && now - last < RING_COOLDOWN_MS - RING_SLACK_MS) return;
    this.rings.set(msg.id, now);
    this.emit("ring", { self: false });
  }

  denied() {
    this.tx = "idle";
    this.publishJson(this.channelTopic(this.channel, "floor"), { id: this.id, op: "rel" });
    this.emit("tx-denied");
  }

  clearFloor() {
    const was = this.floor;
    timers.clear(this.settleTimer);
    this.floor = null;
    if (was?.settled && was.id !== this.id) this.emit("rx-end");
  }

  tick() {
    const now = Date.now();
    if (this.status === "online") {
      const probeLate = this.probeAt !== 0 && now - this.probeAt > PROBE_TIMEOUT_MS;
      if (probeLate || now - this.echoAt > ECHO_TIMEOUT_MS) return this.reconnect();
    }
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.seen > PRESENCE_TTL_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    for (const [id, at] of this.rings) if (now - at > RING_COOLDOWN_MS) this.rings.delete(id);
    if (this.talker && now - this.floor.last > FLOOR_TIMEOUT_MS) {
      this.clearFloor();
      changed = true;
    }
    if (this.tx === "pending" && now - this.txSince > GRANT_TIMEOUT_MS) {
      this.denied();
      changed = true;
    }
    if (this.tx === "on" && now - this.txSince > MAX_TX_MS) {
      this.releaseTalk();
    }
    if (changed || this.tx === "on") this.emit("change");
  }
}
