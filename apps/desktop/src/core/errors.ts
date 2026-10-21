/** Errors carrying a user-facing message; safe to show in the UI. */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const validation = (message: string, details?: unknown) => new AppError('VALIDATION', message, details);
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission for this action') => new AppError('FORBIDDEN', message);
export const conflict = (message: string) => new AppError('CONFLICT', message);
export const offline = (message = 'This action needs a connection to the central server. Check the network and sign in online.') =>
  new AppError('OFFLINE', message);
