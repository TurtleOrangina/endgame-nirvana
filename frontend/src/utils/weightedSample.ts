export const EPSILON = 1e-6

// Temperature-controlled weighted random sampling: weights are normalized, raised to
// 1/temperature (lower temperature → distribution peaks harder on the heaviest
// candidates), renormalized, and then one candidate is drawn.
export function weightedSample<T>(
  candidates: T[],
  weights: number[],
  temperature: number,
  _describe: (candidate: T) => string,
): T {
  const total = weights.reduce((s, w) => s + w, 0)
  const normalized_weights = weights.map((w) => w / total)
  const exponent = 1 / Math.max(0.01, temperature) // Lower cap temperature to avoid division by zero
  const scaled_weights = normalized_weights.map((w) => w ** exponent)
  const scaled_total = scaled_weights.reduce((s, w) => s + w, 0)
  // console.log(
  //   'Picking defensive move from:',
  //   candidates
  //     .map((c, i) => `${describe(c)} ${((scaled_weights[i]! / scaled_total) * 100).toFixed(1)}%`)
  //     .join(', '),
  //   `temperature = ${temperature.toFixed(2)}`,
  // )

  let r = Math.random() * scaled_total
  for (let i = 0; i < candidates.length; i++) {
    r -= scaled_weights[i]!
    if (r <= 0) return candidates[i]!
  }
  throw new Error('Unreachable')
}
