export const EPSILON = 1e-6

// Temperature-controlled weighted random sampling: weights are normalized, raised to
// 1/temperature (lower temperature → distribution peaks harder on the heaviest
// candidates), renormalized, and then one candidate is drawn.
export function weightedSample(
  weights: number[],
  temperature: number,
): [scaled_weights: number[], selected_index: number] {
  const scaled_weights = applyTemperatureToWeights(weights, temperature)

  let r = Math.random()
  for (let i = 0; i < scaled_weights.length; i++) {
    r -= scaled_weights[i]!
    if (r <= 0) return [scaled_weights, i]
  }
  throw new Error('Unreachable')
}

// Normalizes the weights, raises them to 1/temperature and renormalizes, so the
// result is again a probability distribution summing to 1
export function applyTemperatureToWeights(weights: number[], temperature: number): number[] {
  const total = weights.reduce((s, w) => s + w, 0)
  const normalized_weights = weights.map((w) => w / total)
  const exponent = 1 / Math.max(0.01, temperature) // Lower cap temperature to avoid division by zero
  const scaled_weights = normalized_weights.map((w) => w ** exponent)
  const scaled_total = scaled_weights.reduce((s, w) => s + w, 0)
  return scaled_weights.map((w) => w / scaled_total)
}
