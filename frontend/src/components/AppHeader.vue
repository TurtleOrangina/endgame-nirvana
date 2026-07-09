<script setup lang="ts">
import { ref, computed } from 'vue'
import { useLocale } from '@/composables/useLocale'
import type { AppView } from '@/composables/useAppRouter'
import NavIcon from '@/components/NavIcon.vue'

type NavView = Exclude<AppView, 'analysis'>

const props = defineProps<{
  title: string
  activeView: NavView
  username: string | null
}>()

const emit = defineEmits<{
  navigate: [view: NavView]
}>()

const { t } = useLocale()
const dropdownRef = ref<HTMLDetailsElement | null>(null)

type NavIconName = 'dumbbell' | 'trending-up' | 'file-search' | 'settings'

const navItems: { view: NavView; label: () => string; icon: NavIconName }[] = [
  { view: 'training', label: () => t((s) => s.app.navTraining), icon: 'dumbbell' },
  { view: 'solveProgress', label: () => t((s) => s.profile.solveProgress), icon: 'trending-up' },
  {
    view: 'browseExercises',
    label: () => t((s) => s.profile.browseExercises),
    icon: 'file-search',
  },
  { view: 'settings', label: () => t((s) => s.profile.settingsTitle), icon: 'settings' },
]

const activeIcon = computed<NavIconName>(
  () => navItems.find((item) => item.view === props.activeView)?.icon ?? 'dumbbell',
)

function onNavigate(view: NavView): void {
  if (dropdownRef.value) dropdownRef.value.open = false
  if (view !== props.activeView) emit('navigate', view)
}
</script>

<template>
  <div class="app-header" :class="{ wide: activeView === 'training' }">
    <div class="header-left">
      <NavIcon :icon="activeIcon" class="title-icon" />
      <span class="board-title">{{ title }}</span>
    </div>

    <details v-if="username" ref="dropdownRef" class="dropdown">
      <summary class="btn-profile-nav">
        {{ username }}
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
      </summary>
      <div class="dropdown-panel">
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
      </div>
    </details>
  </div>
</template>

<style scoped>
.app-header {
  width: 100%;
  max-width: 720px;
  display: flex;
  align-items: center;
  gap: 2rem;
}

/* On the training view, the board+sidebar layout below can grow wider than the fixed
   720px other pages use — match that width so the menu button stays above the sidebar
   instead of being capped narrower than the content underneath it. */
.app-header.wide {
  max-width: var(--two-col-content-width, 720px);
}

@media (max-width: 720px) {
  .app-header.wide {
    max-width: 720px;
  }
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

.board-title {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
