#!/usr/bin/env node
// Downloads the current puzzle pool (including server-learned current_elo) via the
// export_puzzles RPC and writes it out in the same shape that seed_puzzles.mjs
// consumes as exercises.json — the inverse of that script. Used to periodically pull
// updated difficulties out of the database and back into the frontend's bundled
// asset (frontend/public/exercises.json).
//
// Must be run against production, outside the Docker container (Claude cannot run
// this — no network access to Supabase Cloud from its container). Credentials are
// auto-discovered from the Supabase CLI's already-linked project (supabase/.temp/
// project-ref, written by `supabase link`) and its authenticated session (`supabase
// projects api-keys`, which reuses the CLI's own stored access token) — the same
// state that already lets you run `supabase db push` with no flags.
//
// Deliberately does NOT read SUPABASE_PUBLIC_URL / SUPABASE_SECRET_KEY: those are
// backend/.env's names for the *local* dev stack, and if your shell auto-loads that
// file (direnv, a dotenv zsh plugin, etc.) they'd silently point this script at the
// wrong database. Set SUPABASE_PROJECT_REF to target a project without relying on
// `supabase link`'s .temp file. Zero dependencies — uses only Node builtins + global
// fetch.
//
// Usage: node scripts/export_puzzles.mjs [path-to-write-exercises.json]
// Defaults to ../frontend/public/exercises.json (relative to this script).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)))

function linkedProjectRef() {
  const path = join(backendDir, 'supabase', '.temp', 'project-ref')
  return existsSync(path) ? readFileSync(path, 'utf-8').trim() : null
}

function resolveProjectRef() {
  const projectRef = process.env.SUPABASE_PROJECT_REF || linkedProjectRef()
  if (projectRef) return projectRef

  console.error(
    'No linked Supabase project found (supabase/.temp/project-ref is missing). ' +
      'Run `supabase link` in backend/ first, or set SUPABASE_PROJECT_REF.',
  )
  process.exit(1)
}

// Reuses the CLI's own authenticated session (same one `supabase db push` relies on)
// rather than asking the user to hunt down and paste the service_role/secret key.
function secretKeyViaCli(projectRef) {
  let output
  try {
    output = execFileSync(
      'supabase',
      ['projects', 'api-keys', '--project-ref', projectRef, '-o', 'json'],
      { encoding: 'utf-8' },
    )
  } catch (error) {
    throw new Error(`Could not run \`supabase projects api-keys\` (${error.message}).`)
  }

  const keys = JSON.parse(output)
  const secret = keys.find((key) => key.name === 'secret' || key.name === 'service_role')
  if (!secret) {
    throw new Error('No secret/service_role key in `supabase projects api-keys` output.')
  }
  return secret.api_key
}

function resolveCredentials() {
  const projectRef = resolveProjectRef()
  return {
    supabaseUrl: `https://${projectRef}.supabase.co`,
    secretKey: secretKeyViaCli(projectRef),
  }
}

async function fetchPuzzles(supabaseUrl, secretKey) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/export_puzzles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`export_puzzles RPC failed (${response.status}): ${body}`)
  }

  return response.json()
}

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

const DEFAULT_OUTPUT_PATH = join(backendDir, '..', 'frontend', 'public', 'exercises.json')

async function main() {
  const outputPath = resolve(process.argv[2] ?? DEFAULT_OUTPUT_PATH)

  const { supabaseUrl, secretKey } = resolveCredentials()
  console.log(`Exporting from ${supabaseUrl}`)

  const puzzles = await fetchPuzzles(supabaseUrl, secretKey)
  console.log(`Fetched ${puzzles.length} puzzles`)

  const data = toExercisesJson(puzzles)
  writeFileSync(outputPath, JSON.stringify(data, null, 2))
  console.log(`Wrote ${outputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
