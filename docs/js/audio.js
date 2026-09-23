// Audio engine: microphone capture (via AudioWorklet), jitter-buffered playback
// of received ADPCM chunks and synthesized radio sound effects.

import { AdpcmEncoder, decodeAdpcm } from "./adpcm.js";

const WIRE_RATE = 8000;
const JITTER_S = 0.18; // initial playback delay, absorbs network jitter
const MAX_LAG_S = 1.0; // drop audio if we fall this far behind
const MIC_IDLE_STOP_MS = 8000; // keep the mic warm briefly between transmissions
const HISS_VOLUME = 0.012; // carrier noise under received voice

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.rxIn = null;
    this.noise = null;
    this.hiss = null;
    this.nextTime = 0;
    this.lastSample = 0;
    this.stream = null;
    this.micSource = null;
    this.micNode = null;
    this.onChunk = null;
    this.encoder = new AdpcmEncoder();
    this.micStopTimer = null;
    this.opening = null; // Promise: openMic() in flight
    this.worklet = null; // Promise: capture worklet module loaded (see loadWorklet)
  }

  /**
   * Creates the audio graph and starts the context. Must be called synchronously
   * from a user gesture (click/tap): WebKit lets an AudioContext start only while
   * the gesture is being processed, and a resume() outside of it never settles.
   * That is why nothing here is awaited.
   */
  init() {
    if (this.ctx) {
      this.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    // Received voice: narrow band with a nasal mid bump, like a small radio speaker.
    const highpass = new BiquadFilterNode(ctx, { type: "highpass", frequency: 350 });
    const presence = new BiquadFilterNode(ctx, { type: "peaking", frequency: 1800, Q: 1.1, gain: 5 });
    const lowpass = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 3000 });
    const gain = new GainNode(ctx, { gain: 1.2 });
    highpass.connect(presence).connect(lowpass).connect(gain).connect(ctx.destination);
    this.rxIn = highpass;

    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;

    this.resume();
    this.loadWorklet(); // only needed to transmit: fetch it in the background
  }

  /** Resumes a suspended (or, on iOS, interrupted) context. Fire and forget, see init(). */
  resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running") return;
    ctx.resume().catch((err) => console.warn("[audio] resume", err));
  }

  /** Loads the capture worklet once; a failed load is retried on the next call. */
  loadWorklet() {
    if (!this.worklet) {
      this.worklet = this.ctx.audioWorklet
        ? this.ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url))
        : Promise.reject(new Error("AudioWorklet non supportato"));
      this.worklet.catch(() => (this.worklet = null));
    }
    return this.worklet;
  }

  // ------------------------------------------------------------------ capture

  get micSupported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  /** Opens the microphone (if needed) and calls `onChunk(Uint8Array)` with an ADPCM packet every ~100 ms. */
  async startCapture(onChunk) {
    clearTimeout(this.micStopTimer);
    this.onChunk = onChunk;
    if (this.stream) return;
    if (!this.micSupported) throw new Error("getUserMedia non disponibile (serve HTTPS)");
    this.opening ??= this.openMic().finally(() => (this.opening = null));
    await this.opening;
  }

  async openMic() {
    // Ask for the microphone first, so that the prompt is tied to the user's gesture.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      await this.loadWorklet();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    if (!this.onChunk) {
      // Released (or powered off) while the prompt was open: don't keep the mic on.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micNode = new AudioWorkletNode(this.ctx, "capture-processor", { numberOfOutputs: 1 });
    this.micNode.port.onmessage = (e) => this.onChunk?.(this.encoder.encode(e.data));
    const sink = new GainNode(this.ctx, { gain: 0 }); // keeps the node pulled by the graph
    this.micSource.connect(this.micNode).connect(sink).connect(this.ctx.destination);
  }

  /** Stops delivering chunks; the mic itself is closed after a short idle time. */
  stopCapture() {
    this.onChunk = null;
    clearTimeout(this.micStopTimer);
    this.micStopTimer = setTimeout(() => this.closeMic(), MIC_IDLE_STOP_MS);
  }

  closeMic() {
    this.onChunk = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micSource?.disconnect();
    this.micNode?.disconnect();
    this.stream = this.micSource = this.micNode = null;
  }

  // ------------------------------------------------------------------ playback

  resetPlayback() {
    this.nextTime = 0;
    this.lastSample = 0;
  }

  /** Queue one received ADPCM packet for gap-free playback. */
  play(packet) {
    const ctx = this.ctx;
    const samples = ctx && decodeAdpcm(packet);
    if (!samples) return;
    const now = ctx.currentTime;
    if (this.nextTime - now > MAX_LAG_S) return;
    if (this.nextTime < now + 0.02) this.nextTime = now + JITTER_S;

    // Decode and upsample to the context rate ourselves (some browsers reject 16 kHz buffers).
    const ratio = ctx.sampleRate / WIRE_RATE;
    const outLength = Math.floor(samples.length * ratio);
    const buffer = ctx.createBuffer(1, outLength, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    let prev = this.lastSample;
    for (let i = 0; i < outLength; i++) {
      const pos = i / ratio;
      const idx = Math.floor(pos);
      const a = idx === 0 ? prev : samples[idx - 1];
      const b = samples[idx];
      out[i] = a + (b - a) * (pos - idx);
    }
    this.lastSample = samples[samples.length - 1];

    const src = new AudioBufferSourceNode(ctx, { buffer });
    src.connect(this.rxIn);
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  /** Time at which already queued audio will have finished playing. */
  get playbackEnd() {
    return this.ctx ? Math.max(this.ctx.currentTime, this.nextTime) : 0;
  }

  // ------------------------------------------------------------------ effects

  tone(freq, duration, { at = 0, type = "sine", volume = 0.12 } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const start = Math.max(ctx.currentTime, at);
    const osc = new OscillatorNode(ctx, { type, frequency: freq });
    const gain = new GainNode(ctx, { gain: 0 });
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.005);
    gain.gain.setValueAtTime(volume, start + duration - 0.01);
    gain.gain.linearRampToValueAtTime(0, start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  static(duration, { at = 0, volume = 0.1 } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const start = Math.max(ctx.currentTime, at);
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise });
    const band = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 2200, Q: 0.7 });
    const gain = new GainNode(ctx, { gain: volume });
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(start, Math.random() * 0.5, duration + 0.05);
  }

  /** Floor granted: short double chirp. */
  grantBeep() {
    const t = this.ctx?.currentTime ?? 0;
    this.tone(1320, 0.06, { at: t });
    this.tone(1760, 0.06, { at: t + 0.08 });
  }

  /** End of our transmission ("roger beep"). */
  rogerBeep() {
    this.tone(1200, 0.12, { volume: 0.1 });
  }

  /** Channel busy / request refused. */
  busyTone() {
    const t = this.ctx?.currentTime ?? 0;
    this.tone(420, 0.14, { at: t, type: "square", volume: 0.05 });
    this.tone(420, 0.14, { at: t + 0.2, type: "square", volume: 0.05 });
  }

  /** "Trillo": two bursts of a fast two-tone warble, like an old telephone bell. */
  ring() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const burst of [0, 0.6]) {
      const start = t + burst;
      const end = start + 0.45;
      const osc = new OscillatorNode(ctx, { type: "triangle" });
      for (let at = start, i = 0; at < end; at += 0.025, i++) {
        osc.frequency.setValueAtTime(i % 2 ? 1250 : 1000, at);
      }
      const gain = new GainNode(ctx, { gain: 0 });
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.01);
      gain.gain.setValueAtTime(0.22, end - 0.03);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  }

  /** Carrier noise that stays on while a transmission is being received. */
  startHiss() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopHiss();
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    const band = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 2500, Q: 0.6 });
    const gain = new GainNode(ctx, { gain: HISS_VOLUME });
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start();
    this.hiss = src;
  }

  stopHiss(at = 0) {
    this.hiss?.stop(Math.max(this.ctx.currentTime, at));
    this.hiss = null;
  }

  squelchOpen() {
    this.static(0.08, { volume: 0.06 });
    this.startHiss();
  }

  squelchTail() {
    const end = this.playbackEnd;
    this.stopHiss(end);
    this.static(0.22, { at: end, volume: 0.12 });
  }
}
