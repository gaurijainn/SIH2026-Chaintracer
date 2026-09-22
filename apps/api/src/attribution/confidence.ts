/**
 * Combines independent heuristic confidences into one: 1 - product(1 - p_i). Each fired heuristic is
 * treated as an independent piece of evidence "for" the attribution; noisy-OR means one strong
 * heuristic alone can already give high confidence, and several weak ones can add up, but the result
 * never exceeds 1 (plan B5: "combine heuristic scores with noisy-OR into one confidence").
 */
export function noisyOr(confidences: number[]): number {
  if (confidences.length === 0) return 0;
  const pNone = confidences.reduce((acc, c) => acc * (1 - clamp01(c)), 1);
  return round3(1 - pNone);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
