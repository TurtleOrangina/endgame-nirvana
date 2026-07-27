<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '@/composables/useLocale'
import type { AppView } from '@/composables/useAppRouter'
import type { PieceName } from '@/utils/chess'
import NavIcon from '@/components/NavIcon.vue'
import AppearanceSwatchGrid from '@/components/AppearanceSwatchGrid.vue'

type NavView = Exclude<AppView, 'analysis'>
type SidePieces = { color: 'white' | 'black'; pieces: PieceName[] }

const props = defineProps<{
  title: string
  versusPieces?: { player: SidePieces; opponent: SidePieces } | null
  activeView: NavView
  username: string | null
}>()

const emit = defineEmits<{
  navigate: [view: NavView]
}>()

const { t } = useLocale()
const dropdownRef = ref<HTMLDetailsElement | null>(null)

type NavIconName = 'dumbbell' | 'trending-up' | 'file-search' | 'settings' | 'info'

const navItems: { view: NavView; label: () => string; icon: NavIconName }[] = [
  { view: 'training', label: () => t((s) => s.app.navTraining), icon: 'dumbbell' },
  { view: 'solveProgress', label: () => t((s) => s.profile.solveProgress), icon: 'trending-up' },
  {
    view: 'browseExercises',
    label: () => t((s) => s.profile.browseExercises),
    icon: 'file-search',
  },
  { view: 'settings', label: () => t((s) => s.profile.settingsTitle), icon: 'settings' },
  { view: 'about', label: () => t((s) => s.about.navTitle), icon: 'info' },
]

const activeIcon = computed<NavIconName>(
  () => navItems.find((item) => item.view === props.activeView)?.icon ?? 'dumbbell',
)

function onNavigate(view: NavView): void {
  if (dropdownRef.value) dropdownRef.value.open = false
  if (view !== props.activeView) emit('navigate', view)
}

// Board and piece set are picked from inside the menu rather than only on the settings
// page, so the board stays visible behind it and every choice is judged on the real
// thing. Picking one deliberately leaves the menu open for exactly that reason.
type MenuPanel = 'main' | 'board' | 'pieces'
const menuPanel = ref<MenuPanel>('main')

// The swatch grid is only ever rendered in the non-'main' branch of the template, but
// Vue's compiler can't narrow menuPanel across that v-if/v-else, so this does it for
// the :kind prop.
const appearancePanel = computed((): 'board' | 'pieces' =>
  menuPanel.value === 'board' ? 'board' : 'pieces',
)

const appearancePanelTitle = computed(() =>
  appearancePanel.value === 'board'
    ? t((s) => s.profile.appearance.boardTitle)
    : t((s) => s.profile.appearance.pieceSetTitle),
)

// Reopening the menu always starts at the top level, so it never comes back in a
// submenu the user left behind minutes ago.
function onMenuToggle(): void {
  if (!dropdownRef.value?.open) menuPanel.value = 'main'
}

const versusSides = computed<SidePieces[]>(() =>
  props.versusPieces ? [props.versusPieces.player, props.versusPieces.opponent] : [],
)

// Whether the "player pieces vs computer pieces" title fits the header row. While it
// doesn't fit, the versus title stays rendered but absolutely positioned and invisible,
// so its full width can still be measured against the row and the plain text title is
// shown instead. Starts false so a too-wide versus title never flashes before the
// first measurement.
const versusFits = ref(false)
const titleRowRef = ref<HTMLElement | null>(null)
const versusTitleRef = ref<HTMLElement | null>(null)

function measureVersusFit(): void {
  const row = titleRowRef.value
  const versusTitle = versusTitleRef.value
  if (!row || !versusTitle) return
  versusFits.value = versusTitle.scrollWidth <= row.clientWidth
}

let titleRowResizeObserver: ResizeObserver | null = null

onMounted(() => {
  titleRowResizeObserver = new ResizeObserver(measureVersusFit)
  if (titleRowRef.value) titleRowResizeObserver.observe(titleRowRef.value)
})

onUnmounted(() => {
  titleRowResizeObserver?.disconnect()
})

watch(
  () => props.versusPieces,
  async () => {
    await nextTick()
    measureVersusFit()
  },
)
</script>

<template>
  <div class="app-header">
    <div class="header-left">
      <NavIcon :icon="activeIcon" class="title-icon" />
      <span ref="titleRowRef" class="title-row">
        <span
          v-if="versusPieces"
          ref="versusTitleRef"
          class="versus-title"
          :class="{ measuring: !versusFits }"
          :aria-label="title"
          role="img"
        >
          <template v-for="(side, sideIndex) in versusSides" :key="side.color">
            <span v-if="sideIndex > 0" class="versus-separator">
              {{ t((s) => s.app.versus) }}
            </span>
            <span class="title-pieces cg-wrap">
              <piece
                v-for="(pieceName, index) in side.pieces"
                :key="index"
                :class="[side.color, pieceName]"
              />
            </span>
          </template>
        </span>
        <span v-if="!versusPieces || !versusFits" class="board-title">{{ title }}</span>
      </span>
    </div>

    <details v-if="username" ref="dropdownRef" class="dropdown" @toggle="onMenuToggle">
      <summary class="btn-profile-nav">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="10" r="3" />
          <path d="M6.168 18.849A4 4 0 0 1 10 16h4a4 4 0 0 1 3.834 2.855" />
        </svg>
        {{ username }}
        <NavIcon icon="chevron-down" class="menu-chevron" />
      </summary>

      <div class="dropdown-panel" :class="{ 'appearance-panel': menuPanel !== 'main' }">
        <template v-if="menuPanel === 'main'">
          <div
            v-for="item in navItems"
            :key="item.view"
            class="option"
            :class="{ selected: activeView === item.view }"
            @click="onNavigate(item.view)"
          >
            <NavIcon :icon="item.icon" class="option-icon" />
            <span class="option-label">{{ item.label() }}</span>
          </div>

          <div class="panel-divider" />

          <div class="option" @click="menuPanel = 'board'">
            <NavIcon icon="grid" class="option-icon" />
            <span class="option-label">{{ t((s) => s.profile.appearance.boardTitle) }}</span>
            <NavIcon icon="chevron-right" class="option-icon submenu-arrow" />
          </div>
          <div class="option" @click="menuPanel = 'pieces'">
            <NavIcon icon="crown" class="option-icon" />
            <span class="option-label">{{ t((s) => s.profile.appearance.pieceSetTitle) }}</span>
            <NavIcon icon="chevron-right" class="option-icon submenu-arrow" />
          </div>
        </template>

        <template v-else>
          <div class="option submenu-back" @click="menuPanel = 'main'">
            <NavIcon icon="chevron-left" class="option-icon" />
            <span class="option-label">{{ appearancePanelTitle }}</span>
          </div>

          <div class="panel-divider" />

          <AppearanceSwatchGrid :kind="appearancePanel" class="submenu-swatches" />
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
.app-header {
  width: 100%;
  max-width: var(--page-content-width, 720px);
  display: flex;
  align-items: center;
  gap: 2rem;
}

.header-left {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.title-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--accent);
}

.title-row {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  /* Constant height whichever title variant is shown: tall enough for the 28px
     pieces badges, or the text title's own line height when the user's base
     font size is larger. */
  min-height: max(28px, 1.7rem);
}

.versus-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  overflow: hidden;
}

/* Kept rendered while it doesn't fit so measureVersusFit can still read its full
   width: taken out of flow and hidden, with the chips refusing to shrink so
   scrollWidth reports the width the versus title would actually need. */
.versus-title.measuring {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
}

.versus-separator {
  flex-shrink: 0;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--accent);
}

.board-title {
  min-width: 0;
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Deliberately a fixed light board-square colour (not a theme variable): black pieces
   would otherwise be hard to make out against the dark-mode page background. */
.title-pieces {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 6px;
  background: #ece4d6;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
}

.title-pieces piece {
  position: static;
  display: block;
  width: 24px;
  height: 24px;
  background-size: cover;
}

.dropdown {
  position: relative;
  flex-shrink: 0;
}

.dropdown summary::-webkit-details-marker {
  display: none;
}

.btn-profile-nav {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.8rem;
  cursor: pointer;
  list-style: none;
  transition:
    background 0.1s,
    border-color 0.1s,
    color 0.1s;
  white-space: nowrap;
}

.dropdown[open] .btn-profile-nav {
  border-color: var(--accent);
  color: var(--accent);
}

.btn-profile-nav svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* The affordance that the button opens a menu at all — several users didn't realise
   it was clickable without it. */
.menu-chevron {
  width: 14px;
  height: 14px;
  margin-left: -0.1rem;
  color: var(--muted);
  transition: transform 0.15s;
}

.dropdown[open] .menu-chevron {
  transform: rotate(180deg);
  color: inherit;
}

.btn-profile-nav:hover {
  background: var(--hover-bg);
}

.dropdown-panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  min-width: 180px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

/* Wide enough for four swatches a row, but never wider than the viewport it is
   pinned to the right edge of. */
.appearance-panel {
  width: min(268px, calc(100vw - 2rem));
}

.option {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.4rem 0.6rem;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.1s;
}

.option:hover {
  background: var(--hover-bg);
}

.option.selected {
  background: var(--badge-bg);
  font-weight: 600;
  color: var(--accent);
}

.option-label {
  flex: 1;
  min-width: 0;
}

.option-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--muted);
}

.option.selected .option-icon {
  color: var(--accent);
}

.panel-divider {
  height: 1px;
  margin: 0.3rem 0.2rem;
  background: var(--border);
}

.submenu-arrow {
  margin-right: -0.2rem;
}

.submenu-back .option-label {
  font-weight: 600;
}

/* Every theme at once is taller than a phone screen: the grid scrolls inside the panel
   instead of running off the bottom of the viewport. */
.submenu-swatches {
  --swatch-min-width: 58px;

  max-height: min(60vh, 400px);
  overflow-y: auto;
  padding: 0.1rem;
}
</style>
