/*
 * Kurze Hinweistoene, mit WebAudio erzeugt (keine Audiodateien).
 * App und Browser-Seite nutzen dieses Modul.
 */

let ctx = null;

function play(notes) {
  try {
    ctx = ctx || new AudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, delay, len = 0.45] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + delay);
      gain.gain.linearRampToValueAtTime(0.18, t0 + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + delay + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + len + 0.05);
    }
  } catch (e) {
    console.warn('Ton', e);
  }
}

// Aufsteigend: jemand ist dem eigenen Stream beigetreten.
export function playJoinChime() {
  play([[784, 0], [1175, 0.12]]);
}

// Absteigend: der angesehene Stream wurde beendet.
export function playEndChime() {
  play([[880, 0], [659, 0.16], [440, 0.32, 0.7]]);
}

// Hell, dreifach: jemand ist live gegangen.
export function playLiveChime() {
  play([[659, 0, 0.3], [880, 0.1, 0.3], [1319, 0.2, 0.5]]);
}
