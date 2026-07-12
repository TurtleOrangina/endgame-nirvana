#!/usr/bin/env node
// Downloads the current puzzle pool (including server-learned current_elo) via the
// export_puzzles RPC and writes it out in the same shape that seed_puzzles.mjs
// consumes as exercises.json — the inverse of that script. Used to periodically pull
// updated difficulties out of the database and back into the frontend's bundled
// asset (frontend/public/exercises.json).
//
// Must be run against production, outside the Docker container (Claude cannot run
// this — no network access to Supabase Cloud from its container). Credentials are
// auto-discovered from the Supabase CLI's already-linked project and authenticated
// session — the same state that already lets you run `supabase db push` with no
// flags; see resolveProdCredentials in supabase_client.mjs, including why the
// local stack's SUPABASE_PUBLIC_URL / SUPABASE_SECRET_KEY are deliberately
// ignored. Zero dependencies — uses only Node builtins + global fetch.
//
// If the output file already exists, it is treated as the source of truth for the
// puzzle set: only each existing puzzle's difficulty is refreshed from the server's
// learned current_elo, while categories, expected_result (which may carry manual
// corrections), and locally removed puzzles are left untouched. Server puzzles not
// present in the local file are ignored. A fresh full export is only written when
// the output file does not exist yet.
//
// Usage: node scripts/export_puzzles.mjs [path-to-write-exercises.json]
// Defaults to ../frontend/public/exercises.json (relative to this script).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callRpc, resolveProdCredentials } from './supabase_client.mjs'

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)))

// Groups the flat puzzle rows back into the { "/category/path": [exercise, ...] }
// shape exercises.json uses, inverting seed_puzzles.mjs's loadPuzzles. Sorted by
// category path, then by fen within each category, so the output is deterministic.
function toExercisesJson(puzzles) {
  const grouped = {}
  for (const puzzle of puzzles) {
    const path = `/${puzzle.category_path}`
    const exercises = grouped[path] ?? (grouped[path] = [])
    exercises.push({
      fen: puzzle.id.replaceAll(' ', '_'),
      expected_result: puzzle.expected_result,
      difficulty: puzzle.current_elo,
    })
  }

  const data = {}
  for (const path of Object.keys(grouped).sort()) {
    data[path] = grouped[path].sort((a, b) => a.fen.localeCompare(b.fen))
  }
  return data
}

// Refreshes only the difficulty of puzzles already present in the existing file,
// keeping its puzzle set, categories, and expected_result values as-is.
function mergeDifficultiesIntoExisting(existingData, puzzles) {
  const eloByFen = new Map(puzzles.map((puzzle) => [puzzle.id.replaceAll(' ', '_'), puzzle.current_elo]))

  let updated = 0
  let missingFromServer = 0
  for (const exercises of Object.values(existingData)) {
    for (const exercise of exercises) {
      const currentElo = eloByFen.get(exercise.fen)
      if (currentElo === undefined) {
        missingFromServer += 1
        continue
      }
      exercise.difficulty = currentElo
      updated += 1
    }
  }
  console.log(`Updated difficulty for ${updated} puzzles from the existing file`)
  if (missingFromServer > 0) {
    console.log(`${missingFromServer} local puzzles have no server row — left unchanged`)
  }
  return existingData
}

const DEFAULT_OUTPUT_PATH = join(backendDir, '..', 'frontend', 'public', 'exercises.json')

async function main() {
  const outputPath = resolve(process.argv[2] ?? DEFAULT_OUTPUT_PATH)

  const { supabaseUrl, secretKey } = resolveProdCredentials()
  console.log(`Exporting from ${supabaseUrl}`)

  const puzzles = await callRpc(supabaseUrl, secretKey, 'export_puzzles', {})
  console.log(`Fetched ${puzzles.length} puzzles`)

  const data = existsSync(outputPath)
    ? mergeDifficultiesIntoExisting(JSON.parse(readFileSync(outputPath, 'utf-8')), puzzles)
    : toExercisesJson(puzzles)
  writeFileSync(outputPath, JSON.stringify(data, null, 2))
  console.log(`Wrote ${outputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
