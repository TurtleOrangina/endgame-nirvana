<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Chess } from 'chess.js'
import type {
  EngineLine,
  TablebaseCategory,
  TablebaseMove,
  TablebaseResult,
  AnalysisSettings,
} from '@/types'
import { uciLineToPretty, toFigurineSan } from '@/utils/chess'
import { flipCategory } from '@/composables/useLichessTablebase'
import { useLocale } from '@/composables/useLocale'

const props = defineProps<{
  lines: EngineLine[]
  tablebaseResult: TablebaseResult | null
  isThinking: boolean
  enginePaused: boolean
  tablebaseExpanded: boolean
  fen: string
  settings: AnalysisSettings
}>()

const emit = defineEmits<{
  'execute-move': [uci: string]
  'leave-analysis': []
  'settings-change': [settings: AnalysisSettings]
  'hover-move': [uci: string | null]
  'toggle-engine': []
  'toggle-tablebase-expand': []
  'load-fen': [fen: string]
}>()

const { t } = useLocale()

const showSettings = ref(false)
const expandedLines = ref<number[]>([])
const fenInput = ref(props.fen)
const isFenInputFocused = ref(false)

watch(
  () => props.fen,
  (fen) => {
    if (!isFenInputFocused.value) fenInput.value = fen
  },
)

watch(
  () => props.fen,
  () => {
    expandedLines.value = []
  },
)

const TABLEBASE_COLLAPSED_COUNT = 5

const visibleTablebaseMoves = computed(() => {
  const moves = props.tablebaseResult?.moves ?? []
  return props.tablebaseExpanded ? moves : moves.slice(0, TABLEBASE_COLLAPSED_COUNT)
})

const hiddenTablebaseMoveCount = computed(() =>
  Math.max(0, (props.tablebaseResult?.moves.length ?? 0) - TABLEBASE_COLLAPSED_COUNT),
)

const timeOptions = [
  { label: '8s', value: 8000 },
  { label: '16s', value: 16000 },
  { label: '30s', value: 30000 },
  { label: '60s', value: 60000 },
  { label: '∞', value: Infinity },
]

// Accepts underscore-separated FENs too, matching the format used in shareable URLs.
function normalizeFenInput(value: string): string {
  return value.trim().replaceAll('_', ' ')
}

const fenInputError = computed((): string | null => {
  const normalized = normalizeFenInput(fenInput.value)
  if (!normalized) return null
  try {
    new Chess(normalized)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid FEN'
  }
})

const isBlackTurn = computed(() => props.fen.split(' ')[1] === 'b')

function scoreLabel(line: EngineLine): string {
  if (line.scoreMate !== null) {
    const mate = isBlackTurn.value ? -line.scoreMate : line.scoreMate
    return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`
  }
  if (line.scoreCP !== null) {
    const cp = isBlackTurn.value ? -line.scoreCP : line.scoreCP
    const pawns = (cp / 100).toFixed(1)
    return cp >= 0 ? `+${pawns}` : `${pawns}`
  }
  return '?'
}

const prettyLines = computed(() =>
  props.lines.map((line) => ({
    line,
    score: scoreLabel(line),
    moves: uciLineToPretty(props.fen, line.moves),
  })),
)

const headerInfo = computed(() => {
  const top = prettyLines.value[0]
  if (!top) return null
  return { score: top.score, depth: top.line.depth }
})

// Move categories are from the opponent's perspective. Flip to show the current player's outcome.
function categoryLabel(cat: TablebaseCategory): string {
  const flipped = flipCategory(cat)
  return t((s) => s.analysis.categories[flipped])
}

function categoryClass(cat: TablebaseCategory): string {
  const flipped = flipCategory(cat)
  if (['win', 'syzygy-win', 'maybe-win'].includes(flipped)) return 'cat-win'
  if (['cursed-win', 'draw', 'blessed-loss'].includes(flipped)) return 'cat-draw'
  if (['maybe-loss', 'syzygy-loss', 'loss'].includes(flipped)) return 'cat-loss'
  return 'cat-unknown'
}

function zeroingChip(move: TablebaseMove): string {
  return move.san.includes('x')
    ? t((s) => s.analysis.chipCapture)
    : t((s) => s.analysis.chipPawnMove)
}

function dtzChip(dtz: number): string {
  return dtz === 0 ? t((s) => s.analysis.chipDraw) : `dtz ${Math.abs(dtz)}`
}

function updateSettings(patch: Partial<AnalysisSettings>): void {
  emit('settings-change', { ...props.settings, ...patch })
}

function isExpanded(i: number): boolean {
  return expandedLines.value.includes(i)
}

function toggleExpand(i: number): void {
  const idx = expandedLines.value.indexOf(i)
  if (idx >= 0) {
    expandedLines.value.splice(idx, 1)
  } else {
    expandedLines.value.push(i)
  }
}

function copyFen(): void {
  navigator.clipboard.writeText(props.fen)
}

function onFenInputFocus(): void {
  isFenInputFocused.value = true
}

function onFenInputBlur(): void {
  isFenInputFocused.value = false
  fenInput.value = props.fen
}

function submitFen(event: KeyboardEvent): void {
  const normalized = normalizeFenInput(fenInput.value)
  if (!normalized || fenInputError.value) return
  emit('load-fen', normalized)
  ;(event.target as HTMLInputElement).blur()
}
</script>

<template>
  <div class="analysis-panel">
    <div class="panel-header">
      <button
        class="icon-btn"
        :title="enginePaused ? t((s) => s.analysis.resumeEngine) : t((s) => s.analysis.pauseEngine)"
        @click="emit('toggle-engine')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="none"
        >
          <polygon v-if="enginePaused" points="5,3 19,12 5,21" />
          <g v-else>
            <rect x="5" y="3" width="4" height="18" rx="1" />
            <rect x="15" y="3" width="4" height="18" rx="1" />
          </g>
        </svg>
      </button>

      <span class="panel-title">
        <template v-if="headerInfo">
          {{
            t((s) => s.analysis.headerEval, { score: headerInfo.score, depth: headerInfo.depth })
          }}
        </template>
        <template v-else>{{ t((s) => s.app.analysisTitle) }}</template>
      </span>

      <span
        class="engine-indicator"
        :class="{ spinning: isThinking && !enginePaused }"
        :title="
          isThinking && !enginePaused ? t((s) => s.analysis.calculating) : t((s) => s.analysis.idle)
        "
      />

      <button
        class="icon-btn"
        :title="t((s) => s.analysis.settings)"
        @click="showSettings = !showSettings"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </button>
    </div>

    <div v-if="showSettings" class="settings-panel">
      <div class="setting-row">
        <span class="setting-label">{{ t((s) => s.analysis.thinkingTime) }}</span>
        <div class="time-options">
          <button
            v-for="opt in timeOptions"
            :key="opt.value"
            class="time-btn"
            :class="{ active: settings.thinkingTimeMs === opt.value }"
            @click="updateSettings({ thinkingTimeMs: opt.value })"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="setting-row">
        <span class="setting-label">
          {{ t((s) => s.analysis.linesLabel, { count: settings.numLines }) }}
        </span>
        <input
          type="range"
          min="1"
          max="5"
          :value="settings.numLines"
          class="slider"
          @input="updateSettings({ numLines: parseInt(($event.target as HTMLInputElement).value) })"
        />
      </div>

      <div class="setting-row">
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="settings.showBestArrow"
            @change="updateSettings({ showBestArrow: ($event.target as HTMLInputElement).checked })"
          />
          {{ t((s) => s.analysis.showBestArrow) }}
        </label>
      </div>

      <div class="setting-row">
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="settings.showTablebaseArrow"
            @change="
              updateSettings({ showTablebaseArrow: ($event.target as HTMLInputElement).checked })
            "
          />
          {{ t((s) => s.analysis.showTablebaseArrow) }}
        </label>
      </div>
    </div>

    <div class="engine-lines">
      <div v-if="isThinking && !enginePaused && lines.length === 0" class="thinking-hint">
        {{ t((s) => s.analysis.engineThinkingHint) }}
      </div>
      <div
        v-for="({ line, score, moves }, i) in prettyLines"
        :key="i"
        class="engine-line"
        @mouseenter="emit('hover-move', line.moves[0] ?? null)"
        @mouseleave="emit('hover-move', null)"
        @touchend="emit('hover-move', null)"
        @touchcancel="emit('hover-move', null)"
        @click="line.moves[0] && emit('execute-move', line.moves[0])"
      >
        <span class="line-score">{{ score }}</span>
        <span class="line-moves" :class="isExpanded(i) ? 'expanded' : 'collapsed'">{{
          moves.join(' ')
        }}</span>
        <button
          class="expand-btn"
          :title="isExpanded(i) ? t((s) => s.common.collapse) : t((s) => s.common.expand)"
          @click.stop="toggleExpand(i)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline v-if="isExpanded(i)" points="18 15 12 9 6 15" />
            <polyline v-else points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="tablebaseResult" class="tablebase-section">
      <div class="section-title">{{ t((s) => s.analysis.tablebase) }}</div>
      <div
        v-for="move in visibleTablebaseMoves"
        :key="move.uci"
        class="tb-move"
        @mouseenter="emit('hover-move', move.uci)"
        @mouseleave="emit('hover-move', null)"
        @touchend="emit('hover-move', null)"
        @touchcancel="emit('hover-move', null)"
        @click="emit('execute-move', move.uci)"
      >
        <span class="tb-category" :class="categoryClass(move.category)">{{
          categoryLabel(move.category)
        }}</span>
        <span class="tb-san">{{ toFigurineSan(move.san) }}</span>
        <div class="tb-chips">
          <template v-if="move.checkmate || move.stalemate || move.insufficient_material">
            <span v-if="move.checkmate" class="chip">{{ t((s) => s.analysis.chipCheckmate) }}</span>
            <span v-else-if="move.stalemate" class="chip">
              {{ t((s) => s.analysis.chipStalemate) }}
            </span>
            <span v-else class="chip">{{ t((s) => s.analysis.chipInsufficientMaterial) }}</span>
          </template>
          <template v-else>
            <span v-if="move.zeroing" class="chip">{{ zeroingChip(move) }}</span>
            <span v-if="move.dtz !== null" class="chip">{{ dtzChip(move.dtz) }}</span>
            <span v-if="move.dtm !== null && move.dtz !== 0" class="chip"
              >dtm {{ Math.abs(move.dtm) }}</span
            >
            <span v-if="move.dtc !== null" class="chip">dtc {{ Math.abs(move.dtc) }}</span>
          </template>
        </div>
      </div>

      <button
        v-if="hiddenTablebaseMoveCount > 0 || tablebaseExpanded"
        class="tb-expand-toggle"
        @click="emit('toggle-tablebase-expand')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline v-if="tablebaseExpanded" points="18 15 12 9 6 15" />
          <polyline v-else points="6 9 12 15 18 9" />
        </svg>
        {{
          tablebaseExpanded
            ? t((s) => s.analysis.showLess)
            : t((s) => s.analysis.showMore, { count: hiddenTablebaseMoveCount })
        }}
      </button>
    </div>

    <button class="btn-leave" @click="emit('leave-analysis')">
      {{ t((s) => s.analysis.leaveAnalysis) }}
    </button>

    <div class="fen-section">
      <span class="section-title">{{ t((s) => s.analysis.fen) }}</span>
      <div class="fen-row">
        <input
          v-model="fenInput"
          class="fen-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :title="fen"
          @focus="onFenInputFocus()"
          @blur="onFenInputBlur()"
          @keydown.enter="submitFen($event)"
        />
        <button class="icon-btn" :title="t((s) => s.analysis.copyFen)" @click="copyFen()">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
      <span v-if="isFenInputFocused && fenInputError" class="fen-error">{{ fenInputError }}</span>
    </div>
  </div>
</template>

<style scoped>
.analysis-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.panel-title {
  font-weight: 700;
  font-size: 1rem;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  flex: 1;
}

.engine-indicator {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--border);
  flex-shrink: 0;
  transition: border-color 0.2s;
}

.engine-indicator.spinning {
  border-color: var(--border);
  border-top-color: var(--accent);
  animation: spin 0.75s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: background 0.1s;
}

.icon-btn:hover {
  background: var(--hover-bg);
  color: var(--fg);
}

.icon-btn svg {
  width: 16px;
  height: 16px;
}

.settings-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.setting-label {
  font-size: 0.8rem;
  color: var(--muted);
  min-width: 80px;
}

.time-options {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.time-btn {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.1s;
}

.time-btn:hover {
  background: var(--hover-bg);
}

.time-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #000;
}

.slider {
  flex: 1;
  accent-color: var(--accent);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  cursor: pointer;
}

.checkbox-label input {
  accent-color: var(--accent);
}

.engine-lines {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.thinking-hint {
  font-size: 0.85rem;
  color: var(--muted);
}

.engine-line {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.85rem;
  padding: 0.25rem 0;
  border-bottom: 1px solid var(--border);
  min-width: 0;
  cursor: pointer;
  transition: background 0.1s;
}

.engine-line:hover {
  background: var(--hover-bg);
}

.engine-line:last-child {
  border-bottom: none;
}

.line-score {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-width: 46px;
  color: var(--fg);
  flex-shrink: 0;
}

.line-moves {
  color: var(--fg);
  flex: 1;
  min-width: 0;
}

.line-moves.collapsed {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.line-moves.expanded {
  white-space: normal;
  word-break: break-word;
  line-height: 1.5;
}

.expand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: 3px;
  transition: color 0.1s;
}

.expand-btn:hover {
  color: var(--fg);
}

.expand-btn svg {
  width: 12px;
  height: 12px;
}

.tablebase-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.section-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.1rem;
}

.tb-move {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.1s;
}

.tb-move:hover {
  background: var(--hover-bg);
}

.tb-category {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  flex-shrink: 0;
  white-space: nowrap;
}

.cat-win {
  background: rgba(45, 122, 78, 0.15);
  color: var(--tag-win-fg);
}

.cat-draw {
  background: var(--badge-bg);
  color: var(--tag-draw-fg);
}

.cat-loss {
  background: rgba(192, 64, 79, 0.12);
  color: var(--btn-danger-fg);
}

.cat-unknown {
  background: var(--badge-bg);
  color: var(--muted);
}

.tb-san {
  font-weight: 500;
  flex: 1;
}

.tb-chips {
  display: flex;
  gap: 0.2rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.tb-expand-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  margin-top: 0.2rem;
  padding: 0.3rem;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 0.8rem;
  cursor: pointer;
  border-radius: 5px;
  transition:
    background 0.1s,
    color 0.1s;
}

.tb-expand-toggle:hover {
  background: var(--hover-bg);
  color: var(--fg);
}

.tb-expand-toggle svg {
  width: 12px;
  height: 12px;
}

.chip {
  font-size: 0.7rem;
  color: var(--muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.05rem 0.3rem;
  white-space: nowrap;
}

.btn-leave {
  margin-top: 0.25rem;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.1s;
}

.btn-leave:hover {
  background: var(--hover-bg);
}

.fen-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.fen-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.fen-input {
  flex: 1;
  min-width: 0;
  font-family: monospace;
  font-size: 0.75rem;
  color: var(--fg);
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  transition: background 0.1s;
}

.fen-input:hover {
  background: var(--hover-bg);
}

.fen-input:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--hover-bg);
}

.fen-error {
  font-size: 0.75rem;
  color: var(--btn-danger-fg);
}
</style>
