import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig, type Plugin } from 'vite-plus'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const stockfishBinDir = path.join(projectRoot, 'node_modules', 'stockfish', 'bin')
// Multi-threaded build plus the single-threaded fallback for contexts without
// SharedArrayBuffer (stale cached shell without COOP/COEP, old browsers/WebViews)
const ENGINE_FILES = [
  'stockfish-18-lite.js',
  'stockfish-18-lite.wasm',
  'stockfish-18-lite-single.js',
  'stockfish-18-lite-single.wasm',
]

// Bump to publish the engine assets under a fresh URL without their contents changing.
// Needed when only the *serving* of those files changes in a way a client cannot pick up
// on its own — they carry a one-year `immutable` Cache-Control (see public/_headers), so
// a stored response is never revalidated and a new URL is the only way to evict it. This
// is not hypothetical: copies cached before the COOP/COEP headers existed lack
// `Cross-Origin-Embedder-Policy`, and a cross-origin isolated page refuses to start a
// worker from such a response — leaving the app permanently stuck on "Loading engine…"
// until the user clears their site data by hand.
const ENGINE_ASSET_GENERATION = 2

// SharedArrayBuffer (required by the multi-threaded engine build) only exists in
// cross-origin isolated contexts; production sets the same headers in public/_headers.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Identifies this build to the client. Used to scope the engine's multi-threading
// failover flag, so a redeploy always gets a fresh attempt at the multi-threaded engine
// rather than inheriting a previous build's verdict about it.
const appBuildId = new Date().toISOString()

function engineAssetHash(): string {
  const hash = createHash('sha256').update(`generation:${ENGINE_ASSET_GENERATION}`)
  for (const f of ENGINE_FILES) hash.update(readFileSync(path.join(stockfishBinDir, f)))
  return hash.digest('hex').slice(0, 10)
}

// Stages the engine files under a content-hashed directory (rather than hashed
// filenames: the engine locates its own .wasm by basename relative to the script URL,
// so the pair has to keep their names and move together) and hands the client the
// resulting base path.
function stockfishPlugin(): Plugin {
  return {
    name: 'stockfish-engines',
    config() {
      const enginesRoot = path.join(projectRoot, 'public', 'engines')
      const version = engineAssetHash()
      const destDir = path.join(enginesRoot, version)
      mkdirSync(destDir, { recursive: true })

      // Previous versions would otherwise pile up in dist/ forever
      for (const entry of readdirSync(enginesRoot)) {
        if (entry !== version) rmSync(path.join(enginesRoot, entry), { recursive: true })
      }

      for (const f of ENGINE_FILES) {
        const dest = path.join(destDir, f)
        if (!existsSync(dest)) {
          console.log(`[stockfish] Copying ${f} to public/engines/${version}/ …`)
          copyFileSync(path.join(stockfishBinDir, f), dest)
        }
      }

      return {
        define: {
          __STOCKFISH_ENGINE_BASE_PATH__: JSON.stringify(`/engines/${version}/`),
          __APP_BUILD_ID__: JSON.stringify(appBuildId),
        },
      }
    },
  }
}

// exercises.json (frontend/public/exercises.json, not committed — see .gitignore) is
// periodically refreshed by backend/scripts/export_puzzles.mjs. It's served under a
// content-hashed filename plus a tiny, always-revalidated manifest so the frontend can
// point at it with an aggressive immutable Cache-Control while still picking up a new
// export the next time the app loads (see public/_headers and src/stores/exercises.ts).
function exercisesCatalogPlugin(): Plugin {
  return {
    name: 'exercises-catalog',
    closeBundle() {
      const outDir = path.join(projectRoot, 'dist')
      const plainPath = path.join(outDir, 'exercises.json')
      if (!existsSync(plainPath)) {
        console.warn(
          '[exercises-catalog] dist/exercises.json not found, skipping — copy ' +
            'frontend/public/exercises.json in place before building for production.',
        )
        return
      }

      const contents = readFileSync(plainPath)
      const hash = createHash('sha256').update(contents).digest('hex').slice(0, 10)

      const dataDir = path.join(outDir, 'data')
      mkdirSync(dataDir, { recursive: true })
      const hashedFilename = `exercises-${hash}.json`
      writeFileSync(path.join(dataDir, hashedFilename), contents)
      rmSync(plainPath)

      writeFileSync(
        path.join(outDir, 'exercises-manifest.json'),
        JSON.stringify({ file: `/data/${hashedFilename}` }),
      )
      console.log(`[exercises-catalog] Wrote /data/${hashedFilename} + exercises-manifest.json`)
    },
    configureServer(server) {
      server.middlewares.use('/exercises-manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ file: '/exercises.json' }))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
  },
  lint: {
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'vue'],
    categories: {
      correctness: 'error',
    },
    env: {
      browser: true,
      builtin: true,
    },
    ignorePatterns: [
      '**/dist/**',
      '**/dist-ssr/**',
      '**/coverage/**',
      // Generated by backend/scripts/db.sh types — regenerated, never hand-edited
      'src/types/database.ts',
    ],
    rules: {
      'no-array-constructor': 'error',
      'typescript/ban-ts-comment': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.vue'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
  plugins: [
    stockfishPlugin(),
    exercisesCatalogPlugin(),
    vue({
      template: {
        compilerOptions: { isCustomElement: (tag) => ['piece', 'cg-board'].includes(tag) },
      },
    }),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
})
