import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  UserProfile,
  EloHistoryEntry,
  DifficultyPreference,
  ThemeMode,
  Language,
} from '@/types'
import { detectBrowserLocale } from '@/utils/detectLocale'
import type { Tables } from '@/types/database'
import { migrateLegacyExerciseId } from '@/utils/exerciseId'
import { useSyncStore } from '@/stores/sync'

const STORAGE_KEY = 'userProfile'

function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const profile = JSON.parse(raw) as UserProfile
    // Profiles created before the difficulty-preference feature don't have this field.
    if (!profile.difficultyPreference) profile.difficultyPreference = 'around'
    // Profiles created before the analysis-pause-preference feature don't have this field.
    if (profile.analysisEnginePaused === undefined) profile.analysisEnginePaused = false
    // Profiles created before the tablebase-expanded-preference feature don't have this field.
    if (profile.tablebaseMovesExpanded === undefined) profile.tablebaseMovesExpanded = false
    // Profiles created before the theme-mode feature don't have this field.
    if (!profile.themeMode) profile.themeMode = 'dark'
    // Profiles created before the language feature don't have this field. A static
    // default (not browser re-detection), consistent with the other migrated fields.
    if (!profile.language) profile.language = 'en'
    // Profiles created before Lichess-linking was synced to the backend don't have this field.
    if (profile.lichessUsername === undefined) profile.lichessUsername = null

    // Rewrites any legacy `${path}::${fen}` exerciseIds to the new normalized-FEN id
    // scheme. Idempotent, so it's safe to run on every load; only persists if changed.
    let migrated = false
    for (const entry of profile.eloHistory) {
      if (!entry.exerciseId) continue
      const newId = migrateLegacyExerciseId(entry.exerciseId)
      if (newId !== entry.exerciseId) {
        entry.exerciseId = newId
        migrated = true
      }
    }
    if (migrated) persistProfile(profile)

    return profile
  } catch {
    return null
  }
}

function persistProfile(profile: UserProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
}

export const useUserProfileStore = defineStore('userProfile', () => {
  const profile = ref<UserProfile | null>(null)
  const sessionSolved = ref(0)
  const sessionFailed = ref(0)
  const sessionEloChange = ref(0)
  const lastEloChange = ref<number | null>(null)

  function load(): void {
    profile.value = loadProfile()
  }

  function createProfile(
    username: string,
    startElo: number,
    lichessUsername: string | null = null,
  ): void {
    profile.value = {
      username,
      endgameElo: startElo,
      puzzlesAttempted: 0,
      puzzlesSolved: 0,
      puzzlesFailed: 0,
      eloHistory: [],
      difficultyPreference: 'around',
      analysisEnginePaused: false,
      tablebaseMovesExpanded: false,
      themeMode: 'dark',
      // Auto-detection is a one-time default at profile creation; afterwards the
      // stored (and possibly user-overridden) value always wins.
      language: detectBrowserLocale(),
      lichessUsername,
    }
    persistProfile(profile.value)
    if (lichessUsername) useSyncStore().markProfileDirty()
  }

  function recordResult(
    exerciseDifficulty: number,
    solved: boolean,
    fen?: string,
    exerciseId?: string,
  ): void {
    const p = profile.value
    if (!p) return

    const k = Math.max(16, 64 - p.puzzlesAttempted * 0.5)
    const expected = 1 / (1 + Math.pow(10, (exerciseDifficulty - p.endgameElo) / 400))
    const actual = solved ? 1 : 0
    const delta = Math.round(k * (actual - expected))

    const eloBefore = p.endgameElo
    p.endgameElo += delta
    p.puzzlesAttempted++
    if (solved) {
      p.puzzlesSolved++
      sessionSolved.value++
    } else {
      p.puzzlesFailed++
      sessionFailed.value++
    }

    sessionEloChange.value += delta
    lastEloChange.value = delta

    const entry: EloHistoryEntry = {
      timestamp: new Date().toISOString(),
      exerciseDifficulty,
      change: delta,
      newElo: p.endgameElo,
      fen,
      exerciseId,
      solved,
    }
    p.eloHistory.push(entry)
    persistProfile(p)
    useSyncStore().markProfileDirty()

    if (exerciseId) {
      useSyncStore().enqueueAttempt({
        client_attempt_id: crypto.randomUUID(),
        puzzle_id: exerciseId,
        transformed_fen: fen ?? null,
        solved,
        user_elo_before: eloBefore,
        elo_change: delta,
        new_elo: entry.newElo,
        attempted_at: entry.timestamp,
      })
    }
  }

  function setDifficultyPreference(preference: DifficultyPreference): void {
    const p = profile.value
    if (!p) return
    p.difficultyPreference = preference
    persistProfile(p)
    useSyncStore().markProfileDirty()
  }

  function setAnalysisEnginePaused(paused: boolean): void {
    const p = profile.value
    if (!p) return
    p.analysisEnginePaused = paused
    persistProfile(p)
    useSyncStore().markProfileDirty()
  }

  function setTablebaseMovesExpanded(expanded: boolean): void {
    const p = profile.value
    if (!p) return
    p.tablebaseMovesExpanded = expanded
    persistProfile(p)
    useSyncStore().markProfileDirty()
  }

  function setThemeMode(mode: ThemeMode): void {
    const p = profile.value
    if (!p) return
    p.themeMode = mode
    persistProfile(p)
    useSyncStore().markProfileDirty()
  }

  function setLanguage(language: Language): void {
    const p = profile.value
    if (!p) return
    p.language = language
    persistProfile(p)
    useSyncStore().markProfileDirty()
  }

  function setLichessUsername(username: string | null): void {
    const p = profile.value
    if (!p) return
    p.lichessUsername = username
    persistProfile(p)
    useSyncStore().markProfileDirty()
  }

  // Cloud wins for Elo/settings on login (see backend_plan.md's merge policy). Rebuilds
  // eloHistory from the pulled attempts (last 8 weeks — matches RECENT_ATTEMPT_EXCLUSION_MS
  // in stores/exercises.ts) so recently-attempted/failed-puzzle detection stays correct.
  function applyRemoteProfile(remote: Tables<'profiles'>, attempts: Tables<'attempts'>[]): void {
    const settings = remote.settings as {
      difficultyPreference?: DifficultyPreference
      analysisEnginePaused?: boolean
      tablebaseMovesExpanded?: boolean
      themeMode?: ThemeMode
      language?: Language
      lichessUsername?: string | null
    } | null

    profile.value = {
      username: remote.username,
      endgameElo: remote.endgame_elo,
      puzzlesAttempted: remote.puzzles_attempted,
      puzzlesSolved: remote.puzzles_solved,
      puzzlesFailed: remote.puzzles_failed,
      eloHistory: [...attempts].reverse().map((row) => ({
        timestamp: row.attempted_at,
        // Puzzle difficulty at attempt time isn't tracked server-side. Unused
        // once an entry exists (see recordResult), only kept for the record.
        exerciseDifficulty: 0,
        change: row.elo_change,
        newElo: row.new_elo,
        fen: row.transformed_fen ?? undefined,
        exerciseId: row.puzzle_id ?? undefined,
        solved: row.solved,
      })),
      difficultyPreference: settings?.difficultyPreference ?? 'around',
      analysisEnginePaused: settings?.analysisEnginePaused ?? false,
      tablebaseMovesExpanded: settings?.tablebaseMovesExpanded ?? false,
      themeMode: settings?.themeMode ?? 'dark',
      language: settings?.language ?? 'en',
      lichessUsername: settings?.lichessUsername ?? null,
    }
    persistProfile(profile.value)
  }

  return {
    profile,
    sessionSolved,
    sessionFailed,
    sessionEloChange,
    lastEloChange,
    load,
    createProfile,
    recordResult,
    setDifficultyPreference,
    setAnalysisEnginePaused,
    setTablebaseMovesExpanded,
    setThemeMode,
    setLanguage,
    setLichessUsername,
    applyRemoteProfile,
  }
})
