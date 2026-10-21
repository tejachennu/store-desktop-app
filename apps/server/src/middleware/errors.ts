import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from 'pino';

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

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission for this action') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'CONFLICT', message, details);

export function zodIssues(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid input', details: zodIssues(err) } });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // PostgreSQL constraint errors that reflect user input
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same unique value already exists', details: (err as { detail?: string }).detail } });
      return;
    }
    if (pgCode === '23503') {
      res.status(400).json({ error: { code: 'REFERENCE', message: 'Referenced record does not exist' } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
      return;
    }
    log.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  };
}
