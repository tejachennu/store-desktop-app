import type { ApiArgs, ApiMethod, ApiResult } from '../../../core/api';

/** Methods implemented only in the Electron main process (not part of the core). */
interface ShellMethods {
  'print.html': { args: { html: string; silent?: boolean; widthMm?: number }; result: { ok: boolean; error?: string } };
  'print.printers': { args: void; result: { name: string; isDefault: boolean }[] };
  'app.openDataDir': { args: void; result: string };
  'app.version': { args: void; result: { version: string; electron: string; dataDir: string } };
  'backup.chooseFile': { args: void; result: string | null };
  'app.saveCsv': { args: { name: string; content: string }; result: { saved: boolean; path?: string } };
}

type AnyMethod = ApiMethod | keyof ShellMethods;
type Args<M extends AnyMethod> = M extends ApiMethod ? ApiArgs<M> : M extends keyof ShellMethods ? ShellMethods[M]['args'] : never;
type Result<M extends AnyMethod> = M extends ApiMethod ? ApiResult<M> : M extends keyof ShellMethods ? ShellMethods[M]['result'] : never;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Typed call into the main process. Rejects with ApiError carrying a user-facing message. */
export async function call<M extends AnyMethod>(method: M, ...args: Args<M> extends void ? [] : [Args<M>]): Promise<Result<M>> {
  const res = (await window.storeApi.invoke(method, args[0])) as { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok) throw new ApiError(res.error?.code ?? 'ERROR', res.error?.message ?? 'Something went wrong', res.error?.details);
  return res.data as Result<M>;
}

/** Calls the central REST API through the main process (online sign-in required). */
export function central<T = any>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  return call('central.request', { method, path, body }) as Promise<T>;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
