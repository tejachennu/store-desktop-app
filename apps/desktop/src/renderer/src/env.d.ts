/// <reference types="vite/client" />
import type { PreloadApi } from '../../../electron/preload';

declare global {
  interface Window {
    storeApi: PreloadApi;
  }
}
export {};
