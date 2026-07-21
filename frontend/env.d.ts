/// <reference types="vite-plus/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// Injected by stockfishPlugin() in vite.config.ts
declare const __STOCKFISH_ENGINE_BASE_PATH__: string
declare const __APP_BUILD_ID__: string

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
