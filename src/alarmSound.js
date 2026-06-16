// A self-contained "timer went off" alarm tone, synthesized with the Web Audio
// API so the app ships no audio asset. startAlarm() begins the familiar
// kitchen/phone-timer cadence — a repeating triple-beep — and returns a stop()
// function. Call stop() to silence it (the timer's dismiss click).
//
// Browsers block audio until a user gesture, so if the AudioContext can't start
// (e.g. the budget expired in a backgrounded tab before any interaction) the
// alarm degrades silently to the visual pulse — startAlarm() never throws and
// the next real click resumes the context.

let ctx = null;
function audioCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch { return null; }
  return ctx;
}

// One beep: a square tone with a short attack/release envelope so it doesn't
// click on/off. `at` is an absolute AudioContext time.
function beep(ac, at, freq, dur) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.16, at + 0.012);
  gain.gain.setValueAtTime(0.16, at + dur - 0.02);
  gain.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

// One "ring" = three short beeps at the same pitch — the standard timer triple.
function ring(ac) {
  const t0 = ac.currentTime + 0.02;
  beep(ac, t0, 880, 0.11);
  beep(ac, t0 + 0.17, 880, 0.11);
  beep(ac, t0 + 0.34, 880, 0.11);
}

// Start the alarm; returns stop(). Idempotent enough for React effect cleanup.
export function startAlarm() {
  const ac = audioCtx();
  if (!ac) return () => {};
  try { if (ac.state === 'suspended') ac.resume(); } catch { /* gesture-gated */ }
  ring(ac);
  const id = setInterval(() => {
    try {
      if (ac.state === 'suspended') ac.resume();
      ring(ac);
    } catch { /* keep ticking; a later gesture lets it through */ }
  }, 1500);
  return () => clearInterval(id);
}
