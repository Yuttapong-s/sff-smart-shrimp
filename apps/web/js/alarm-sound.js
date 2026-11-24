// In-app alarm sound while the app is open: a siren-like beep pattern when a critical alarm is
// unacknowledged, repeated every 30 s until someone acknowledges it. Per-device on/off switch.

const KEY = 'sff-sound';
let ctx = null;
let timer = null;

export function soundEnabled() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {}
  if (!on) stopAlarmSound();
}

/** Play the pattern once (also used by the "test" button; needs a prior user gesture). */
export function beep(level = 'crit') {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime;
    const notes = level === 'crit' ? [880, 660, 880, 660, 880, 660] : [660, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      const s = t0 + i * 0.28;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.24);
      o.connect(g).connect(ctx.destination);
      o.start(s);
      o.stop(s + 0.26);
    });
  } catch {
    // no audio (autoplay policy / unsupported): the visual alarm still shows
  }
}

/** Keep sounding while there are unacknowledged critical alarms. */
export function updateAlarmSound(unackedCrit) {
  if (!unackedCrit || !soundEnabled()) return stopAlarmSound();
  if (timer) return;
  const play = () => document.visibilityState === 'visible' && beep('crit');
  play();
  timer = setInterval(play, 30_000);
}

export function stopAlarmSound() {
  clearInterval(timer);
  timer = null;
}
