import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Snackbar } from '@mui/material';
import type { Permission } from '@store/shared';
import type { ApiResult } from '../../core/api';
import { call } from './lib/api';

type Info = ApiResult<'app.info'>;
type SyncStatus = ApiResult<'sync.status'>;
type Severity = 'success' | 'info' | 'warning' | 'error';

interface AppState {
  info: Info | null;
  sync: SyncStatus | null;
  refresh: () => Promise<void>;
  can: (p: Permission) => boolean;
  notify: (message: string, severity?: Severity) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [toast, setToast] = useState<{ message: string; severity: Severity; key: number } | null>(null);

  const refresh = useCallback(async () => {
    const i = await call('app.info');
    setInfo(i);
    setSync(i.sync);
  }, []);

  useEffect(() => {
    void refresh();
    const off1 = window.storeApi.onSyncStatus((s) => setSync(s as SyncStatus));
    const off2 = window.storeApi.onDataChanged(() => void refresh());
    return () => {
      off1();
      off2();
    };
  }, [refresh]);

  const value = useMemo<AppState>(
    () => ({
      info,
      sync,
      refresh,
      can: (p) => !!info?.session?.user.permissions.includes(p),
      notify: (message, severity = 'success') => setToast({ message, severity, key: Date.now() }),
    }),
    [info, sync, refresh],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <Snackbar
        key={toast?.key}
        open={!!toast}
        autoHideDuration={toast?.severity === 'error' ? 8000 : 4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert severity={toast?.severity ?? 'info'} variant="filled" onClose={() => setToast(null)} sx={{ minWidth: 320 }}>
          {toast?.message}
        </Alert>
      </Snackbar>
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
