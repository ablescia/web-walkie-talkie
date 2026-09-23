// IMA ADPCM (4 bit/sample) for 8 kHz voice: 32 kbit/s on the wire.
//
// Packet layout (little endian):
//   0..1  int16  predictor before the first sample
//   2     uint8  step index before the first sample (0..88)
//   3     uint8  reserved (0)
//   4..   samples, two per byte, low nibble first
//
// The header carries the codec state, so every packet decodes on its own even
// if a previous one was lost or we tuned in mid-transmission.

export const HEADER_BYTES = 4;

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724,
  796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
  4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
  20350, 22385, 24623, 27086, 29794, 32767,
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Applies one 4-bit code to the state and returns the new predictor. */
function step(state, code) {
  const s = STEP_TABLE[state.index];
  let diff = s >> 3;
  if (code & 4) diff += s;
  if (code & 2) diff += s >> 1;
  if (code & 1) diff += s >> 2;
  state.predictor = clamp(state.predictor + (code & 8 ? -diff : diff), -32768, 32767);
  state.index = clamp(state.index + INDEX_TABLE[code & 7], 0, 88);
  return state.predictor;
}

export class AdpcmEncoder {
  constructor() {
    this.state = { predictor: 0, index: 0 };
  }

  /** Encodes float samples in [-1, 1] into one self-contained packet. */
  encode(samples) {
    const state = this.state;
    const out = new Uint8Array(HEADER_BYTES + Math.ceil(samples.length / 2));
    const view = new DataView(out.buffer);
    view.setInt16(0, state.predictor, true);
    out[2] = state.index;

    for (let i = 0; i < samples.length; i++) {
      const target = Math.round(clamp(samples[i], -1, 1) * 32767);
      let diff = target - state.predictor;
      let code = 0;
      if (diff < 0) {
        code = 8;
        diff = -diff;
      }
      let s = STEP_TABLE[state.index];
      if (diff >= s) {
        code |= 4;
        diff -= s;
      }
      s >>= 1;
      if (diff >= s) {
        code |= 2;
        diff -= s;
      }
      s >>= 1;
      if (diff >= s) code |= 1;
      step(state, code); // track exactly what the decoder will reconstruct
      out[HEADER_BYTES + (i >> 1)] |= i & 1 ? code << 4 : code;
    }
    return out;
  }
}

/** Decodes one packet into float samples, or returns null if it is malformed. */
export function decodeAdpcm(packet) {
  if (!(packet instanceof Uint8Array) || packet.length <= HEADER_BYTES) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const state = { predictor: view.getInt16(0, true), index: clamp(packet[2], 0, 88) };
  const count = (packet.length - HEADER_BYTES) * 2;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const byte = packet[HEADER_BYTES + (i >> 1)];
    out[i] = step(state, i & 1 ? byte >> 4 : byte & 0x0f) / 32768;
  }
  return out;
}
