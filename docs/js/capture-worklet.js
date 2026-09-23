// AudioWorklet: shapes the microphone like a radio transmitter (300-3000 Hz
// band, soft clipping), resamples it to 8 kHz and posts one ~100 ms chunk
// (Float32Array) at a time to the main thread, which encodes it.

const TARGET_RATE = 8000;
const CHUNK_SAMPLES = 800;
const LOW_CUT_HZ = 300;
const HIGH_CUT_HZ = 3000;
const DRIVE = 2.2; // soft-clip drive: compresses peaks and adds a bit of grit

/** RBJ cookbook biquad (direct form I). */
class Biquad {
  constructor(type, freq, rate, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * freq) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
    const b0 = type === "lowpass" ? b1 / 2 : -b1 / 2;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b0 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.pos = 0; // fractional read position inside the current input block
    this.prev = 0; // last sample of the previous block (for interpolation)
    // 4th-order low-pass at the input rate: band limit + anti-aliasing before decimation.
    this.antiAlias = [new Biquad("lowpass", HIGH_CUT_HZ, sampleRate), new Biquad("lowpass", HIGH_CUT_HZ, sampleRate)];
    this.lowCut = [new Biquad("highpass", LOW_CUT_HZ, TARGET_RATE), new Biquad("highpass", LOW_CUT_HZ, TARGET_RATE)];
    this.chunk = new Float32Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const filtered = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      filtered[i] = this.antiAlias[1].run(this.antiAlias[0].run(channel[i]));
    }
    while (this.pos < filtered.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : filtered[i - 1];
      const b = filtered[i];
      const voice = this.lowCut[1].run(this.lowCut[0].run(a + (b - a) * frac));
      this.chunk[this.filled++] = Math.tanh(DRIVE * voice);
      if (this.filled === CHUNK_SAMPLES) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(CHUNK_SAMPLES);
        this.filled = 0;
      }
      this.pos += this.step;
    }
    this.pos -= filtered.length;
    this.prev = filtered[filtered.length - 1];
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
