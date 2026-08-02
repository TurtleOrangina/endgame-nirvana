export interface DistributionSummary {
  count: number
  mean: number
  max: number
  // Population standard deviation: these are the complete set of defensive moves that
  // were actually played, not a sample drawn from a larger pool
  stdDev: number
}

export function summarize(values: number[]): DistributionSummary {
  if (values.length === 0) return { count: 0, mean: 0, max: 0, stdDev: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return { count: values.length, mean, max: Math.max(...values), stdDev: Math.sqrt(variance) }
}

export function formatPercent(fraction: number, fractionDigits = 1): string {
  return `${(fraction * 100).toFixed(fractionDigits)}%`
}
