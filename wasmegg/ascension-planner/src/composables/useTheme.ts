import { ref, computed, watch } from 'vue';

// Must match the inline pre-paint script in index.html, which applies the theme before Vue loads.
const STORAGE_KEY = 'ascension_theme';

type ThemeChoice = 'light' | 'dark';

function loadStoredTheme(): ThemeChoice | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
const systemPrefersDark = ref(systemQuery.matches);
systemQuery.addEventListener('change', e => (systemPrefersDark.value = e.matches));

// null = no explicit choice yet, so follow the browser/OS setting (including live changes to it).
const storedTheme = ref<ThemeChoice | null>(loadStoredTheme());

/**
 * Whether dark mode is active. A single module-level computed so the nav toggle, the charts, and
 * the <html class="dark"> switch all agree. The palette itself lives in tailwind.config.ts.
 */
export const isDark = computed(() => (storedTheme.value ?? (systemPrefersDark.value ? 'dark' : 'light')) === 'dark');

watch(isDark, dark => document.documentElement.classList.toggle('dark', dark), { immediate: true });

export function toggleTheme() {
  storedTheme.value = isDark.value ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, storedTheme.value);
  } catch {
    // Storage blocked (private mode etc.): the choice still holds for this page view.
  }
}
