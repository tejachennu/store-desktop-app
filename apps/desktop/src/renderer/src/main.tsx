import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { HashRouter } from 'react-router-dom';
import { theme } from './theme';
import { AppStateProvider } from './AppState';
import { App } from './App';

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
