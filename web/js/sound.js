// sound.js — tiny WebAudio-synthesised effects (no audio files). Off by default; the
// AudioContext is created lazily on the first sound after a user gesture.

export class SoundFx {
  constructor() {
    this.enabled = false;
    this.ctx = null;
    this.master = null;
    this.activated = false;
    // Browsers only allow audio after a user gesture: create/resume the context then.
    if (typeof window !== 'undefined' && window.addEventListener) {
      const onGesture = () => {
        this.activated = true;
        if (this.enabled) this._ensure();
      };
      window.addEventListener('pointerdown', onGesture, true);
      window.addEventListener('keydown', onGesture, true);
    }
  }

  _mayPlay() {
    if (this.activated) return true;
    try {
      return !!(globalThis.navigator && navigator.userActivation && navigator.userActivation.hasBeenActive);
    } catch (e) {
      return false;
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled && this._mayPlay()) this._ensure();
  }

  _ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      this.ctx = null;
    }
    return this.ctx;
  }

  // A short filtered noise burst: the "wood" of a piece being set down.
  _knock(t, { freq = 1800, q = 1.2, gain = 0.5, dur = 0.07 } = {}) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // A soft sine "body" under the knock, or a bell-like tone.
  _tone(t, { from = 220, to = 160, gain = 0.25, dur = 0.09, type = 'sine' } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** kind: 'move' | 'capture' | 'check' | 'end' | 'illegal' */
  play(kind) {
    if (!this.enabled || !this._mayPlay()) return;
    const ctx = this._ensure();
    if (!ctx) return;
    try {
      const t = ctx.currentTime + 0.01;
      switch (kind) {
        case 'capture':
          this._knock(t, { freq: 1300, q: 0.9, gain: 0.75, dur: 0.09 });
          this._tone(t, { from: 170, to: 95, gain: 0.32, dur: 0.12 });
          this._knock(t + 0.045, { freq: 2300, q: 1.6, gain: 0.35, dur: 0.05 });
          break;
        case 'check':
          this._knock(t, { freq: 1900, gain: 0.45 });
          this._tone(t + 0.02, { from: 990, to: 930, gain: 0.12, dur: 0.22, type: 'triangle' });
          this._tone(t + 0.02, { from: 1485, to: 1400, gain: 0.05, dur: 0.18 });
          break;
        case 'end':
          [523.25, 659.25, 783.99].forEach((f, i) => {
            this._tone(t + i * 0.11, { from: f, to: f * 0.995, gain: 0.12, dur: 0.5, type: 'triangle' });
          });
          break;
        case 'illegal':
          this._tone(t, { from: 180, to: 140, gain: 0.12, dur: 0.12, type: 'square' });
          break;
        default:
          this._knock(t, { freq: 1700, q: 1.1, gain: 0.55, dur: 0.07 });
          this._tone(t, { from: 230, to: 150, gain: 0.2, dur: 0.08 });
      }
    } catch (e) {
      /* audio is decoration only */
    }
  }
}
