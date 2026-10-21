import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { SecretStore } from '../src/core/context';

/**
 * Secrets (device key) encrypted with the OS keychain via Electron safeStorage —
 * DPAPI on Windows, bound to the logged-in Windows user. Stored outside the
 * SQLite database so a copied store.db does not carry the device credentials.
 */
export class SafeStorageSecretStore implements SecretStore {
  constructor(private file: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(name: string): string | null {
    const v = this.read()[name];
    if (!v) return null;
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf8');
    return null;
  }

  set(name: string, value: string): void {
    const data = this.read();
    data[name] = safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(value).toString('base64')}`
      : // Only on systems without a keychain (some Linux dev setups). Windows always has DPAPI.
        `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
    this.write(data);
  }

  delete(name: string): void {
    const data = this.read();
    delete data[name];
    this.write(data);
  }
}
