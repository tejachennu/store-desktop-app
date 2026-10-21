import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { errorMessage } from './api';

/** Load data asynchronously; reloads when deps change or when the main process reports new synced data. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList = [], opts: { refreshOnSync?: boolean } = { refreshOnSync: true }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await fnRef.current();
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!opts.refreshOnSync) return;
    return window.storeApi.onDataChanged(() => void reload());
  }, [reload, opts.refreshOnSync]);

  return { data, error, loading, reload, setData };
}

/** Global keyboard shortcut (e.g. F2) while the component is mounted. */
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === key) {
        e.preventDefault();
        ref.current(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, enabled]);
}
