#!/usr/bin/env node
// Seeds/refreshes the public.puzzles table from an already-deduped
// exercises.json via the seed_puzzles RPC. By default the server-side pool is
// made to exactly match the file: after seeding, puzzles missing from the file
// are deleted via the prune_puzzles RPC (their attempt history survives —
// attempts.puzzle_id is `on delete set null`). Pass --only-add to skip the
// prune and leave puzzles not in the file untouched. Zero dependencies — uses
// only Node builtins + global fetch.
//
// Targets the local dev stack by default, authenticating with
// SUPABASE_PUBLIC_URL / SUPABASE_SECRET_KEY from backend/.env (run via
// `sh scripts/db.sh seed [path]`, which sources .env first). Pass --prod to
// seed production instead: credentials are then discovered through the
// Supabase CLI's linked project and authenticated session (same mechanism as
// export_puzzles.mjs) and the .env variables are ignored.
//
// Usage: node scripts/seed_puzzles.mjs [--prod] [--only-add] [path-to-exercises.json]
// Defaults to ../frontend/public/exercises.json (relative to this script),
// analogous to export_puzzles.mjs.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callRpc, resolveProdCredentials } from './supabase_client.mjs'

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_INPUT_PATH = join(backendDir, '..', 'frontend', 'public', 'exercises.json')

const BATCH_SIZE = 500

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return value
}

function loadPuzzles(exercisesJsonPath) {
  const raw = readFileSync(exercisesJsonPath, 'utf-8')
  const data = JSON.parse(raw)

  const puzzles = []
  const seenIds = new Set()
  const duplicateIds = new Set()

  for (const [path, exercises] of Object.entries(data)) {
    const categoryPath = path.startsWith('/') ? path.slice(1) : path
    for (const exercise of exercises) {
      const id = exercise.fen.replaceAll('_', ' ')
      if (seenIds.has(id)) duplicateIds.add(id)
      seenIds.add(id)

      puzzles.push({
        id,
        category_path: categoryPath,
        expected_result: exercise.expected_result,
        initial_elo: Number(exercise.difficulty),
      })
    }
  }

  if (duplicateIds.size > 0) {
    console.error(
      `Refusing to seed: ${duplicateIds.size} duplicate FEN(s) found in exercises.json. ` +
        'Dedupe the file before seeding.',
    )
    process.exit(1)
  }

  return puzzles
}

function resolveLocalCredentials() {
  return {
    supabaseUrl: requireEnv('SUPABASE_PUBLIC_URL'),
    secretKey: requireEnv('SUPABASE_SECRET_KEY'),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const prod = args.includes('--prod')
  const onlyAdd = args.includes('--only-add')
  const unknownFlag = args.find((arg) => arg.startsWith('--') && arg !== '--prod' && arg !== '--only-add')
  if (unknownFlag) {
    console.error(`Unknown flag: ${unknownFlag}`)
    console.error('Usage: node scripts/seed_puzzles.mjs [--prod] [--only-add] [path-to-exercises.json]')
    process.exit(1)
  }
  const exercisesJsonPathArg = args.find((arg) => !arg.startsWith('--'))
  const exercisesJsonPath = resolve(exercisesJsonPathArg || DEFAULT_INPUT_PATH)

  const { supabaseUrl, secretKey } = prod ? resolveProdCredentials() : resolveLocalCredentials()
  console.log(`Seeding ${supabaseUrl}${prod ? ' (production)' : ''}`)

  const puzzles = loadPuzzles(exercisesJsonPath)
  console.log(`Loaded ${puzzles.length} puzzles from ${exercisesJsonPath}`)

  let seeded = 0
  for (let start = 0; start < puzzles.length; start += BATCH_SIZE) {
    const batch = puzzles.slice(start, start + BATCH_SIZE)
    const count = await callRpc(supabaseUrl, secretKey, 'seed_puzzles', { p_puzzles: batch })
    seeded += count
    console.log(`Seeded batch ${start / BATCH_SIZE + 1}: ${count} puzzles (${seeded}/${puzzles.length} total)`)
  }

  if (onlyAdd) {
    console.log(`Done. Seeded ${seeded} puzzles (--only-add: server-side puzzles not in the file were kept).`)
    return
  }

  const pruned = await callRpc(supabaseUrl, secretKey, 'prune_puzzles', {
    p_keep_ids: puzzles.map((puzzle) => puzzle.id),
  })
  console.log(`Done. Seeded ${seeded} puzzles, pruned ${pruned} no longer in the file.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
