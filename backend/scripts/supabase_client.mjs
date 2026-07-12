// Shared helpers for the puzzle seed/export scripts: production credential
// discovery via the Supabase CLI, and a thin PostgREST RPC caller. Zero
// dependencies — uses only Node builtins + global fetch.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

// Deliberately does NOT read SUPABASE_PUBLIC_URL / SUPABASE_SECRET_KEY: those are
// backend/.env's names for the *local* dev stack, and if the shell auto-loads that
// file (direnv, a dotenv zsh plugin, etc.) they'd silently point the caller at the
// wrong database. Set SUPABASE_PROJECT_REF to target a project without relying on
// `supabase link`'s .temp file.
export function resolveProdCredentials() {
  const projectRef = resolveProjectRef()
  return {
    supabaseUrl: `https://${projectRef}.supabase.co`,
    secretKey: secretKeyViaCli(projectRef),
  }
}

export async function callRpc(supabaseUrl, secretKey, rpcName, body) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`${rpcName} RPC failed (${response.status}): ${errorBody}`)
  }

  return response.json()
}
