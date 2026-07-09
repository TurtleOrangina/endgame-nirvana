// Matches the 8-week retention window the backend enforces on `attempts`
// (see backend/supabase/migrations, record_attempts/pull_state) — used both to
// filter recently-attempted puzzles (src/stores/exercises.ts) and to prune the
// locally-cached eloHistory (src/stores/userProfile.ts).
export const RECENT_ATTEMPT_EXCLUSION_MS = 8 * 7 * 24 * 60 * 60 * 1000
