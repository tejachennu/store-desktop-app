import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** The only bridge between the sandboxed UI and the main process. */
const api = {
  invoke: (method: string, args?: unknown) => ipcRenderer.invoke('api', method, args),
  onSyncStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, s: unknown) => cb(s);
    ipcRenderer.on('sync-status', listener);
    return () => {
      ipcRenderer.removeListener('sync-status', listener);
    };
  },
  onDataChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('data-changed', listener);
    return () => {
      ipcRenderer.removeListener('data-changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('storeApi', api);
export type PreloadApi = typeof api;
