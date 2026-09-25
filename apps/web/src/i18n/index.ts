import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { hi } from './hi';

export type Language = 'en' | 'hi';
export const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
];
export const isLanguage = (v: unknown): v is Language => v === 'en' || v === 'hi';

/**
 * English source text is the translation key, so English is the identity and any string without a Hindi entry simply stays
 * English. Only UI labels are translated: addresses, hashes, VASP names, user input, backend errors and backend-generated
 * report/notice text are never passed through `t`.
 */
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { hi: { translation: hi } },
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export function setDocumentLanguage(lng: Language) {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}

export default i18n;
