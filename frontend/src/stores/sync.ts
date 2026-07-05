import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { debounce } from 'es-toolkit'
import { supabase } from '@/lib/supabaseClient'
import { useUserProfileStore } from '@/stores/userProfile'
import { useExercisesStore } from '@/stores/exercises'
import { useLichessAuth } from '@/composables/useLichessAuth'
import type { Json, Tables } from '@/types/database'

const OUTBOX_STORAGE_KEY = 'syncOutbox'
const PROFILE_DIRTY_STORAGE_KEY = 'syncProfileDirty'
const PUZZLE_ELO_OVERRIDES_STORAGE_KEY = 'puzzleEloOverrides'
const FLUSH_DEBOUNCE_MS = 30_000

// Mirrors record_attempts' expected jsonb shape (backend/supabase/migrations).
export interface PendingAttempt {
  client_attempt_id: string
  puzzle_id: string
  transform_code: string
  solved: boolean
  user_elo_before: number
  elo_change: number
  new_elo: number
  attempted_at: string
}

interface PullStateResult {
  profile: Tables<'profiles'> | null
  attempts: Tables<'attempts'>[]
  puzzles: { id: string; elo: number }[]
}

function loadOutbox(): PendingAttempt[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PendingAttempt[]) : []
  } catch {
    return []
  }
}

function persistOutbox(outbox: PendingAttempt[]): void {
  localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(outbox))
}

function loadProfileDirty(): boolean {
  return localStorage.getItem(PROFILE_DIRTY_STORAGE_KEY) === 'true'
}

function persistProfileDirty(dirty: boolean): void {
  localStorage.setItem(PROFILE_DIRTY_STORAGE_KEY, String(dirty))
}

function loadPuzzleEloOverrides(): Map<string, number> {
  try {
    const raw = localStorage.getItem(PUZZLE_ELO_OVERRIDES_STORAGE_KEY)
    if (!raw) return new Map()
    return new Map(Object.entries(JSON.parse(raw) as Record<string, number>))
  } catch {
    return new Map()
  }
}

function persistPuzzleEloOverrides(overrides: Map<string, number>): void {
  localStorage.setItem(
    PUZZLE_ELO_OVERRIDES_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(overrides)),
  )
}

function isTouchedPuzzleList(value: unknown): value is { id: string; elo: number }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry): entry is { id: string; elo: number } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        typeof (entry as { elo?: unknown }).elo === 'number',
    )
  )
}

export const useSyncStore = defineStore('sync', () => {
  const outbox = ref<PendingAttempt[]>(loadOutbox())
  const profileDirty = ref(loadProfileDirty())
  const puzzleEloOverrides = ref<Map<string, number>>(loadPuzzleEloOverrides())
  const isSyncing = ref(false)
  const lastSyncError = ref<string | null>(null)
  const pendingCount = computed(() => outbox.value.length + (profileDirty.value ? 1 : 0))

  function enqueueAttempt(attempt: PendingAttempt): void {
    outbox.value.push(attempt)
    persistOutbox(outbox.value)
    debouncedFlush()
  }

  function markProfileDirty(): void {
    profileDirty.value = true
    persistProfileDirty(true)
    debouncedFlush()
  }

  function applyTouchedPuzzles(data: unknown): void {
    if (!isTouchedPuzzleList(data)) return
    for (const { id, elo } of data) puzzleEloOverrides.value.set(id, elo)
    persistPuzzleEloOverrides(puzzleEloOverrides.value)
  }

  // At most 2 requests per flush: one record_attempts RPC for the outbox, one
  // profiles update if dirty. Never throws — failures leave outbox/profileDirty
  // untouched so the next debounced/manual flush retries.
  async function flush(): Promise<void> {
    if (!supabase || isSyncing.value) return
    if (outbox.value.length === 0 && !profileDirty.value) return

    isSyncing.value = true
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) return

      if (outbox.value.length > 0) {
        const { data, error } = await supabase.rpc('record_attempts', {
          p_attempts: outbox.value as unknown as Json,
        })
        if (error) throw error
        outbox.value = []
        persistOutbox([])
        applyTouchedPuzzles(data)
      }

      if (profileDirty.value) {
        const profile = useUserProfileStore().profile
        if (profile) {
          const { data, error } = await supabase
            .from('profiles')
            .update({
              username: profile.username,
              endgame_elo: profile.endgameElo,
              puzzles_attempted: profile.puzzlesAttempted,
              puzzles_solved: profile.puzzlesSolved,
              puzzles_failed: profile.puzzlesFailed,
              settings: {
                difficultyPreference: profile.difficultyPreference,
                analysisEnginePaused: profile.analysisEnginePaused,
                tablebaseMovesExpanded: profile.tablebaseMovesExpanded,
                themeMode: profile.themeMode,
                language: profile.language,
                lichessUsername: profile.lichessUsername,
              },
            })
            .eq('id', session.user.id)
            .select('id')
          if (error) throw error
          // update() reports success even when RLS filters out the target row,
          // since PostgREST only errors on a genuine failure, not a 0-row match —
          // treat a silent no-op as a failure so it isn't mistaken for a synced state.
          if (!data || data.length === 0) {
            throw new Error('Profile update matched no row (check RLS policy / session user id)')
          }
        }
        profileDirty.value = false
        persistProfileDirty(false)
      }

      lastSyncError.value = null
    } catch (error) {
      lastSyncError.value = error instanceof Error ? error.message : 'Sync failed'
    } finally {
      isSyncing.value = false
    }
  }

  const debouncedFlush = debounce(() => void flush(), FLUSH_DEBOUNCE_MS)

  // Single login-hydration call. Any pending local profile/attempts changes are
  // flushed to the server first, then cloud wins for profile/settings (see
  // backend_plan.md) using that now-up-to-date state.
  async function pullRemoteState(): Promise<void> {
    if (!supabase) return
    try {
      // Push any locally-accumulated but not-yet-synced profile/attempts first —
      // otherwise the "cloud wins" apply below would silently discard them. Note
      // this runs far more often than just login: supabase-js re-emits SIGNED_IN
      // (and therefore pullRemoteState) on every tab focus, not only real sign-in.
      await flush()

      const { data, error } = await supabase.rpc('pull_state')
      if (error) throw error
      const state = data as unknown as PullStateResult

      // If the push above failed (profileDirty/lastSyncError still set), the
      // cloud row we just fetched is known-stale — applying it would overwrite
      // correct local progress with old data instead of leaving it queued.
      if (state.profile && !profileDirty.value && !lastSyncError.value) {
        useUserProfileStore().applyRemoteProfile(state.profile, state.attempts)
        useExercisesStore().rebuildFromRemoteAttempts(state.attempts)
        // A Lichess account linked mid signup-wizard (before this account's first
        // pull) isn't in the cloud profile yet — re-apply it so "cloud wins"
        // doesn't silently drop the link.
        useLichessAuth().applyPendingUsernameToProfile()
      }

      puzzleEloOverrides.value = new Map(state.puzzles.map((puzzle) => [puzzle.id, puzzle.elo]))
      persistPuzzleEloOverrides(puzzleEloOverrides.value)

      lastSyncError.value = null
    } catch (error) {
      lastSyncError.value = error instanceof Error ? error.message : 'Sync failed'
    }
  }

  function syncNow(): void {
    debouncedFlush.cancel()
    void flush()
  }

  function setUpAutoFlushListeners(): void {
    window.addEventListener('online', syncNow)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') syncNow()
    })
  }

  return {
    profileDirty,
    puzzleEloOverrides,
    isSyncing,
    lastSyncError,
    pendingCount,
    enqueueAttempt,
    markProfileDirty,
    pullRemoteState,
    syncNow,
    setUpAutoFlushListeners,
  }
})
