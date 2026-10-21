import { AppError } from '../errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thrown when the server could not be reached (DNS, refused, timeout). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  appVersion?: string;
}

export function normaliseServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('VALIDATION', 'Enter a valid server address, e.g. https://store-api.example.com');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError('VALIDATION', 'Server address must start with http:// or https://');
  return trimmed;
}

/** Thin REST client for the central API. */
export class ApiClient {
  private fetchImpl: FetchLike;
  constructor(private opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { body?: unknown; token?: string | null; deviceKey?: string | null; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.deviceKey) headers['X-Device-Key'] = opts.deviceKey;
    if (this.opts.appVersion) headers['X-App-Version'] = this.opts.appVersion;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new NetworkError((err as Error).message || 'Network error');
    }
    const text = await res.text().catch(() => '');
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new HttpError(res.status, 'BAD_RESPONSE', 'Server returned an invalid response');
      }
    }
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new HttpError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? `Server error (${res.status})`, e.details);
    }
    return data as T;
  }

  get<T>(path: string, opts?: Parameters<ApiClient['request']>[2]) {
    return this.request<T>('GET', path, opts);
  }
  post<T>(path: string, body: unknown, opts?: Parameters<ApiClient['request']>[2]) {
    return this.request<T>('POST', path, { ...opts, body });
  }
  put<T>(path: string, body: unknown, opts?: Parameters<ApiClient['request']>[2]) {
    return this.request<T>('PUT', path, { ...opts, body });
  }
}

/** Convert client errors into user-facing AppErrors. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof NetworkError) return new AppError('OFFLINE', 'Cannot reach the central server. Check the network connection.');
  if (err instanceof HttpError) {
    const code = err.status === 401 ? 'UNAUTHORIZED' : err.status === 403 ? 'FORBIDDEN' : err.code;
    return new AppError(code, err.message, err.details);
  }
  return new AppError('INTERNAL', (err as Error)?.message ?? 'Unexpected error');
}
