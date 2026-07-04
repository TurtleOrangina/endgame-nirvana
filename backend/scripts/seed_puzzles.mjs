#!/usr/bin/env node
// Seeds/refreshes the public.puzzles table from an already-deduped
// exercises.json via the seed_puzzles RPC. Zero dependencies — uses only
// Node builtins + global fetch. Run via `sh scripts/db.sh seed <path>`,
// which sources backend/.env first.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

async function seedBatch(supabaseUrl, secretKey, batch) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/seed_puzzles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
    body: JSON.stringify({ p_puzzles: batch }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`seed_puzzles RPC failed (${response.status}): ${body}`)
  }

  return response.json()
}

async function main() {
  const exercisesJsonPathArg = process.argv[2]
  if (!exercisesJsonPathArg) {
    console.error('Usage: node scripts/seed_puzzles.mjs <path-to-exercises.json>')
    process.exit(1)
  }
  const exercisesJsonPath = resolve(exercisesJsonPathArg)

  const supabaseUrl = requireEnv('SUPABASE_PUBLIC_URL')
  const secretKey = requireEnv('SUPABASE_SECRET_KEY')

  const puzzles = loadPuzzles(exercisesJsonPath)
  console.log(`Loaded ${puzzles.length} puzzles from ${exercisesJsonPath}`)

  let seeded = 0
  for (let start = 0; start < puzzles.length; start += BATCH_SIZE) {
    const batch = puzzles.slice(start, start + BATCH_SIZE)
    const count = await seedBatch(supabaseUrl, secretKey, batch)
    seeded += count
    console.log(`Seeded batch ${start / BATCH_SIZE + 1}: ${count} puzzles (${seeded}/${puzzles.length} total)`)
  }

  console.log(`Done. Seeded ${seeded} puzzles.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
