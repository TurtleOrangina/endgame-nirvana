import {
  createMeasurementRunner,
  DEFAULT_CONFIG,
  formatPuzzleReport,
  formatSummary,
  writeReport,
  type MeasurementConfig,
  type PuzzleMeasurement,
} from './measurementHarness'

// Entry point for scripts/measure-defensive-resistance.mjs. The Vitest suite in
// defensiveResistance.test.ts drives the same harness one test case per puzzle instead.
export type MeasurementOptions = Partial<MeasurementConfig> & { frontendRoot: string }

export async function runMeasurement(options: MeasurementOptions): Promise<PuzzleMeasurement[]> {
  // Spelled out rather than spread, so an option the CLI left unset (undefined) falls back
  // to the default instead of overwriting it with undefined
  const config: MeasurementConfig = {
    frontendRoot: options.frontendRoot,
    binaryPath: options.binaryPath ?? DEFAULT_CONFIG.binaryPath,
    engineThreads: options.engineThreads,
    puzzlesPerGroup: options.puzzlesPerGroup ?? DEFAULT_CONFIG.puzzlesPerGroup,
    playoutsPerPuzzle: options.playoutsPerPuzzle ?? DEFAULT_CONFIG.playoutsPerPuzzle,
    seed: options.seed ?? DEFAULT_CONFIG.seed,
    minTablebaseRequestIntervalMs: options.minTablebaseRequestIntervalMs,
  }
  const runner = createMeasurementRunner(config)
  const measurements: PuzzleMeasurement[] = []

  console.log(
    `Measuring defensive resistance over ${runner.puzzles.length} puzzles ` +
      `× ${config.playoutsPerPuzzle} playouts (seed ${config.seed}).\n` +
      'The user side plays perfect shortest-mate tablebase moves; the defender is the ' +
      "app's own move selection.",
  )

  try {
    for (const puzzle of runner.puzzles) {
      const measurement = await runner.measurePuzzle(puzzle)
      measurements.push(measurement)
      console.log(formatPuzzleReport(measurement))
    }
  } finally {
    runner.shutDown()
  }

  console.log(formatSummary(measurements, runner.tablebase))
  const { jsonPath, textPath } = writeReport(measurements, config, runner.tablebase)
  console.log(`\nReport written to ${textPath}\nPer-move detail written to ${jsonPath}`)
  return measurements
}
