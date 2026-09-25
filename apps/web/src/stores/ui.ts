import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n, { isLanguage, setDocumentLanguage, type Language } from '@/i18n';

export type ThemePreference = 'dark' | 'light' | 'system';

interface UiState {
  theme: ThemePreference;
  /** Interface language; English is the default. */
  language: Language;
  setLanguage: (l: Language) => void;
  sidebarCollapsed: boolean;
  /** Mobile drawer; never persisted. */
  mobileNavOpen: boolean;
  /** User opted in to the CRITICAL alert beep (needs a click first, so it is off until chosen). */
  alertSoundEnabled: boolean;
  setAlertSoundEnabled: (on: boolean) => void;
  setTheme: (t: ThemePreference) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setMobileNavOpen: (open: boolean) => void;
}

export const resolveDark = (t: ThemePreference) =>
  t === 'dark' || (t === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);

export function applyLanguage(l: Language) {
  setDocumentLanguage(l);
  void i18n.changeLanguage(l);
}

export function applyTheme(t: ThemePreference) {
  document.documentElement.classList.toggle('dark', resolveDark(t));
}

/** UI-only state. Server data belongs in TanStack Query. Key matches the pre-paint script in index.html. */
export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      language: 'en',
      setLanguage: (language) => {
        applyLanguage(language);
        set({ language });
      },
      sidebarCollapsed: false,
      mobileNavOpen: false,
      alertSoundEnabled: false,
      setAlertSoundEnabled: (alertSoundEnabled) => set({ alertSoundEnabled }),
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      toggleTheme: () => get().setTheme(resolveDark(get().theme) ? 'light' : 'dark'),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
    }),
    {
      name: 'ps26183.ui',
      partialize: (s) => ({ theme: s.theme, language: s.language, sidebarCollapsed: s.sidebarCollapsed, alertSoundEnabled: s.alertSoundEnabled }),
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.theme ?? 'dark');
        applyLanguage(isLanguage(state?.language) ? state.language : 'en');
      },
    },
  ),
);
