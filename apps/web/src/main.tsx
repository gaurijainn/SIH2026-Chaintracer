import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import { App } from './App';
import './index.css';
import { createQueryClient } from './lib/queryClient';
import { applyLanguage, applyTheme, useUiStore } from './stores/ui';

applyTheme(useUiStore.getState().theme);
applyLanguage(useUiStore.getState().language);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
);
