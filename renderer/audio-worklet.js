// AudioWorklet: spielt den PCM-Ton des Hilfsprogramms (Float32, Stereo,
// 48 kHz, 10-ms-Pakete) ab. Kleiner Jitter-Puffer: erst ab 40 ms Vorrat
// starten, bei Leerlauf Stille und neu puffern, bei Stau aufholen.
const CAP = 48000 * 2;      // 1 s Stereo
const START = 1920;         // 40 ms
const MAX = 12000;          // 250 ms -> zu viel Verzoegerung
const AFTER_SKIP = 2880;    // auf 60 ms zurueckspringen

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CAP * 2);
    this.read = 0;
    this.write = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) {
        e.data.port.onmessage = (m) => this.push(m.data);
      }
    };
  }

  frames() {
    return (this.write - this.read) / 2;
  }

  push(u8) {
    const f = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
    for (let i = 0; i < f.length; i++) this.buf[(this.write + i) % this.buf.length] = f[i];
    this.write += f.length;
    if (this.frames() > MAX) this.read = this.write - AFTER_SKIP * 2;
  }

  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    const n = l.length;
    if (!this.playing && this.frames() >= START) this.playing = true;
    if (!this.playing || this.frames() < n) {
      this.playing = false;
      l.fill(0);
      if (r) r.fill(0);
      return true;
    }
    const len = this.buf.length;
    for (let i = 0; i < n; i++) {
      l[i] = this.buf[this.read % len];
      if (r) r[i] = this.buf[(this.read + 1) % len];
      this.read += 2;
    }
    return true;
  }
}

registerProcessor('kmdev-pcm-player', PcmPlayer);
