/**
 * Offline-synthesized game sounds (no assets).
 *
 * App wires an isEnabled callback via init(); play calls no-op when disabled.
 * Practice/每日 call playMove/playAnswer directly — they read the same
 * `enabled` callback, so the 声音 switch stays one source of truth.
 *
 * Two rules this module holds, both learned elsewhere in this codebase:
 *
 *  1. **One voice.** Every non-percussive sound goes through `tone()`. The
 *     six-line oscillator+gain construction used to be written out twice
 *     inside playWin; 胜/负/和/答题 would have made it six copies — the same
 *     shape as the four hand-copied stone painters draw.js spent v1.37–v1.40
 *     collapsing into one `paintStone`.
 *  2. **Direction carries the meaning.** 赢 rises, 输 falls, 和 settles.
 *     输棋不是惩罚 —— the losing motif is a descending *major* triad over a
 *     bare fifth, not a minor buzz. What it says is 「这局结束了」, not
 *     「你错了」.
 *
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

  /**
   * The one voice. Every pitched sound in the app is a call to this.
   *
   * `glide` exists because the stone body sweeps its pitch over 0.08s while
   * its envelope runs 0.12s — folding the two into one duration would have
   * changed a sound this version is not supposed to touch.
   *
   * @param {AudioContext} ctx
   * @param {{at:number, f0:number, f1?:number, glide?:number, peak:number,
   *          attack?:number, dur:number, tail?:number, type?:string}} o
   */
  function tone(ctx, o) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || "triangle";
    osc.frequency.setValueAtTime(o.f0, o.at);
    if (o.f1 && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(o.f1, o.at + (o.glide || o.dur));
    }
    // 0 is not a legal target for an exponential ramp — 0.0001 is the floor
    // this module has always used to mean silence.
    g.gain.setValueAtTime(0.0001, o.at);
    g.gain.exponentialRampToValueAtTime(o.peak, o.at + (o.attack || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, o.at + o.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(o.at);
    osc.stop(o.at + o.dur + (o.tail || 0.01));
  }

  /** A short sequence of `tone` calls, spaced evenly. Returns the end time. */
  function motif(ctx, at, freqs, gap, o) {
    freqs.forEach((f, i) => tone(ctx, Object.assign({}, o, { at: at + i * gap, f0: f })));
    return at + freqs.length * gap;
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
      tone(ctx, {
        at: t0,
        f0: color === "b" ? 250 : 340,
        f1: color === "b" ? 180 : 250,
        glide: 0.08, peak: 0.1, attack: 0.008, dur: 0.12, tail: 0.01,
      });
    } catch (_) {}
  }

  /**
   * The three ways a game ends. One shape, three directions:
   *
   *   赢  C5→E5→G5→C6 上行，落在完整的大三和弦上
   *   输  G4→E4→C4 下行(同一个大三和弦,倒过来走)，落在纯五度上
   *   和  C5→G4 两个音，落在同一个纯五度上，最短
   *
   * 输为什么不用小调:小三度会把「这局结束了」念成「你错了」。倒着走的大三和弦
   * 说的是方向,不是评判;落点抽掉三度(只留纯五度)则连明暗都不表态。
   * 和局比输更短、更轻 —— 它连方向都没有。
   *
   * 之前这三种情况共用同一段上行琶音:电脑赢棋时应用也在奏凯歌。实测两次对局的
   * 音频图逐个音符相同(noise, osc, 523.25, 659.25, 783.99, 1046.5, 523.25,
   * 659.25, 783.99),那不是设计,是 place() 里 playWinSound() 无条件触发。
   *
   * @param {'win'|'loss'|'draw'} outcome 站在**用户**的角度,不是站在赢家的角度
   */
  function playEnd(outcome) {
    if (!enabled()) return;
    try {
      const ctx = ensureAudio();
      const t0 = ctx.currentTime;
      let tc, chord, sustain, peak;
      if (outcome === "loss") {
        tc = motif(ctx, t0, [392, 329.63, 261.63], 0.1,
          { peak: 0.09, attack: 0.02, dur: 0.26, tail: 0.02 }) + 0.02;
        chord = [261.63, 392];          // C4 + G4 — 纯五度,不表态
        sustain = 0.5; peak = 0.05;
      } else if (outcome === "draw") {
        tc = motif(ctx, t0, [523.25, 392], 0.1,
          { peak: 0.08, attack: 0.02, dur: 0.24, tail: 0.02 }) + 0.02;
        chord = [261.63, 392];
        sustain = 0.35; peak = 0.045;
      } else {
        tc = motif(ctx, t0, [523.25, 659.25, 783.99, 1046.5], 0.085,
          { peak: 0.11, attack: 0.02, dur: 0.24, tail: 0.02 }) + 0.02;
        chord = [523.25, 659.25, 783.99];
        sustain = 0.6; peak = 0.06;
      }
      chord.forEach((f) => tone(ctx, {
        at: tc, f0: f, type: "sine", peak: peak, attack: 0.04, dur: sustain, tail: 0.04,
      }));
    } catch (_) {}
  }

  /**
   * 答题的反馈。刻意做得比对局结束小一个量级 —— 一轮练习要答几十次,
   * 每次都来一段琶音是灾难。两个音、0.12s,方向与 playEnd 同一套语汇。
   */
  function playAnswer(correct) {
    if (!enabled()) return;
    try {
      const ctx = ensureAudio();
      // 答题时棋子和判定是同一次点击,两个声音叠在一起会糊成一团。落在落子声的
      // 尾巴上(body 的包络是 0.12s),读起来就是「子落下 → 判定」两拍,和视觉上
      // 「棋子出现 → 标记染成红/绿」的顺序一致。用 Web Audio 的时间轴排,不用
      // setTimeout —— 前者是采样精确的,后者会被主线程的重绘挤开。
      motif(ctx, ctx.currentTime + 0.14, correct ? [659.25, 783.99] : [392, 329.63], 0.09,
        { peak: correct ? 0.07 : 0.06, attack: 0.012, dur: 0.12, tail: 0.01 });
    } catch (_) {}
  }

  global.GobanAudio = { init, playMove, playEnd, playAnswer };
})(typeof window !== "undefined" ? window : globalThis);
