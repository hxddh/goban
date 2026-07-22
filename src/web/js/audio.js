/**
 * Offline-synthesized game sounds (no assets): woody stone clack + win chord.
 * App wires an isEnabled callback via init(); play calls no-op when disabled.
 * @module audio
 */
(function (global) {
  let audioCtx = null;
  let enabled = () => true;

  function init(isEnabled) {
    if (typeof isEnabled === "function") enabled = isEnabled;
  }

  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  /** Cached short white-noise buffer — reused for every stone's "clack". */
  let noiseBuf = null;
  function noiseBuffer(ctx) {
    if (noiseBuf) return noiseBuf;
    const n = Math.floor(ctx.sampleRate * 0.06);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 0x2545f491; // deterministic — no Math.random needed
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x40000000 - 1) * (1 - i / n); // fade toward silence
    }
    return noiseBuf;
  }

  // A stone on a wooden board is a percussive click (bandpassed noise) plus a
  // short woody body resonance — far more tactile than a bare sine beep.
  function playMove(color) {
    if (!enabled()) return;
    try {
      const ctx = ensureAudio();
      const t0 = ctx.currentTime;
      // 1) the clack: brief bandpassed noise burst
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = color === "b" ? 1900 : 2300;
      bp.Q.value = 0.9;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.22, t0);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
      src.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
      src.start(t0); src.stop(t0 + 0.06);
      // 2) the body: fast-decaying woody tone, black lower than white
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(color === "b" ? 250 : 340, t0);
      osc.frequency.exponentialRampToValueAtTime(color === "b" ? 180 : 250, t0 + 0.08);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.13);
    } catch (_) {}
  }

  function playWin() {
    if (!enabled()) return;
    try {
      const ctx = ensureAudio();
      // rising major arpeggio, then a soft sustained chord to land on
      const arp = [523.25, 659.25, 783.99, 1046.5];
      arp.forEach((f, i) => {
        const t0 = ctx.currentTime + i * 0.085;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.26);
      });
      const tc = ctx.currentTime + arp.length * 0.085 + 0.02;
      [523.25, 659.25, 783.99].forEach((f) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, tc);
        g.gain.exponentialRampToValueAtTime(0.06, tc + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.6);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(tc); osc.stop(tc + 0.64);
      });
    } catch (_) {}
  }

  global.GobanAudio = { init, playMove, playWin };
})(typeof window !== "undefined" ? window : globalThis);
