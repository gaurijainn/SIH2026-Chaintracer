import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { createQueryClient } from './lib/queryClient';
import { applyTheme, useUiStore } from './stores/ui';

applyTheme(useUiStore.getState().theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
);
