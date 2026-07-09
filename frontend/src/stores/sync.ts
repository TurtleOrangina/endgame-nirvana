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
const FLUSH_DEBOUNCE_MS = 30_000

// Postgres error code for a foreign key violation.
const FOREIGN_KEY_VIOLATION = '23503'

// Pulls the offending value out of a Postgres FK violation's detail message, e.g.
// `Key (puzzle_id)=(8/3b4/8/8/p7/k7/2K5/8 w - - 20 1) is not present in table "puzzles".`
function extractMissingPuzzleId(details: string | null): string | null {
  return details?.match(/Key \(puzzle_id\)=\((.+)\) is not present in table/)?.[1] ?? null
}

// Puzzle difficulty now comes solely from the bundled exercises.json; drop the
// server-Elo override map older app versions persisted.
localStorage.removeItem('puzzleEloOverrides')

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

export const useSyncStore = defineStore('sync', () => {
  const outbox = ref<PendingAttempt[]>(loadOutbox())
  const profileDirty = ref(loadProfileDirty())
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

  let inFlightFlush: Promise<void> | null = null

  // Concurrent callers await the same in-flight flush instead of silently
  // no-oping — pullRemoteState relies on `await flush()` meaning "pending local
  // state was actually pushed (or failed, setting lastSyncError)" before it
  // lets the pulled cloud profile overwrite the local one. A no-op return here
  // let a stale pull win the moment the real flush cleared profileDirty.
  function flush(): Promise<void> {
    if (!inFlightFlush) {
      inFlightFlush = performFlush().finally(() => {
        inFlightFlush = null
      })
    }
    return inFlightFlush
  }

  // At most 2 requests per flush: one record_attempts RPC for the outbox, one
  // profiles update if dirty. Never throws — failures leave outbox/profileDirty
  // untouched so the next debounced/manual flush retries.
  async function performFlush(): Promise<void> {
    if (!supabase) return
    if (outbox.value.length === 0 && !profileDirty.value) return

    isSyncing.value = true
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) return

      if (outbox.value.length > 0) {
        // record_attempts runs the whole batch inside one implicit transaction (it's a
        // plain plpgsql loop with no per-row exception handling), so a single attempt
        // whose puzzle_id no longer exists server-side — e.g. pruned by a later
        // exercises.json export, see backend/scripts/seed_puzzles.mjs — aborts the
        // entire call and rolls back every attempt in it. Left alone, that one
        // unrecoverable attempt would sit in the outbox forever and wedge every other
        // (valid) attempt behind it too, since a normal failure never clears the
        // outbox. Drop the specific offending attempt — identified from the FK
        // violation's error detail — and retry with what's left, bounded so a
        // genuinely broken RPC can't loop forever.
        let synced = false
        for (let i = 0; i <= outbox.value.length; i++) {
          const { error } = await supabase.rpc('record_attempts', {
            p_attempts: outbox.value as unknown as Json,
          })
          if (!error) {
            synced = true
            break
          }
          const badPuzzleId =
            error.code === FOREIGN_KEY_VIOLATION ? extractMissingPuzzleId(error.details) : null
          if (!badPuzzleId) throw error
          const countBefore = outbox.value.length
          outbox.value = outbox.value.filter((a) => a.puzzle_id !== badPuzzleId)
          persistOutbox(outbox.value)
          if (outbox.value.length === countBefore) throw error
          if (outbox.value.length === 0) {
            synced = true
            break
          }
        }
        if (!synced)
          throw new Error('record_attempts kept failing after removing invalid puzzle ids')
        outbox.value = []
        persistOutbox([])
      }

      if (profileDirty.value) {
        const profile = useUserProfileStore().profile
        if (profile) {
          const { data, error } = await supabase
            .from('profiles')
            .update({
              // Puzzle counters are deliberately absent: they're server-derived
              // by record_attempts, and the client's update grant no longer
              // covers those columns.
              username: profile.username,
              endgame_elo: profile.endgameElo,
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
