import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { HashRouter } from 'react-router-dom';
import { z } from 'zod';
import { theme } from './theme';
import { AppStateProvider } from './AppState';
import { App } from './App';

// The CSP forbids eval; skip zod's JIT probe instead of logging a CSP violation.
z.config({ jitless: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppStateProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </AppStateProvider>
    </ThemeProvider>
  </StrictMode>,
);
