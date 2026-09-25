/**
 * A short synthesised beep (Web Audio), so no audio file is bundled or fetched. Browsers refuse to start audio before a
 * user gesture, so nothing plays until `primeAlertSound` has run from a click; `playAlertSound` is then a no-op unless the
 * context is actually running. It plays once per call, never loops.
 */
let ctx: AudioContext | null = null;

export function primeAlertSound(): boolean {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function playAlertSound(): boolean {
  if (!ctx || ctx.state !== 'running') return false;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.setValueAtTime(660, t + 0.15);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.35);
  return true;
}
