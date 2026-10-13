/* Orbit — notification sounds synthesized with the Web Audio API (no audio files).
 * Runs in the offscreen document (AUDIO_PLAYBACK reason) so it plays even when the
 * page that hosts the panel has no user gesture yet.
 */
let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function env(gain, t0, a, d, peak) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + a);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}

const SOUNDS = {
  // short two-note sine blip
  blip(c, vol) {
    const t = c.currentTime;
    [[880, 0], [1320, 0.07]].forEach(([f, dt]) => {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f, t + dt);
      env(g, t + dt, 0.008, 0.12, 0.25 * vol);
      o.connect(g).connect(c.destination); o.start(t + dt); o.stop(t + dt + 0.2);
    });
  },
  // soft "pop": filtered noise burst + low sine thump
  pop(c, vol) {
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.08);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.08);
    const g = c.createGain(); env(g, t, 0.003, 0.09, 0.35 * vol);
    src.connect(f).connect(g).connect(c.destination); src.start(t);
    const o = c.createOscillator(); const g2 = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.1);
    env(g2, t, 0.005, 0.12, 0.3 * vol);
    o.connect(g2).connect(c.destination); o.start(t); o.stop(t + 0.15);
  },
  // gentle triangle chime (major third)
  chime(c, vol) {
    const t = c.currentTime;
    [[659.25, 0], [830.61, 0.12], [987.77, 0.24]].forEach(([f, dt]) => {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, t + dt);
      env(g, t + dt, 0.01, 0.45, 0.18 * vol);
      o.connect(g).connect(c.destination); o.start(t + dt); o.stop(t + dt + 0.6);
    });
  }
};

export const SOUND_NAMES = Object.keys(SOUNDS);

export function playSound(name, volume = 1) {
  try {
    const c = ac();
    (SOUNDS[name] || SOUNDS.blip)(c, Math.max(0, Math.min(1, volume)));
  } catch (e) { console.warn('[Orbit/sound]', e); }
}
