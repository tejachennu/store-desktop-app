import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

/** Small fixed-window in-memory limiter (per IP + key). Good enough for a single API instance. */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Parameters<RequestHandler>[0]) => string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const k = `${req.ip}:${opts.key ? opts.key(req) : ''}`;
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      for (const [key, e] of hits) if (e.resetAt <= now) hits.delete(key);
    }
    if (entry.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
    }
    next();
  };
}
