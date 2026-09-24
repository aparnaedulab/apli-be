/**
 * Every failure the API returns deliberately is one of these. Anything else
 * that reaches the error handler is a bug, and is logged as one rather than
 * being flattened into a friendly message - the reference codebase swallowed
 * 273 exceptions into generic responses, which is how a dead feature went
 * unnoticed for years.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'You must be signed in.') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

/** An attempted move the state machine does not allow. */
export class IllegalTransition extends AppError {
  constructor(from: string, to: string) {
    super(409, 'ILLEGAL_TRANSITION', `An application cannot move from ${from} to ${to}.`, {
      from,
      to,
    });
    this.name = 'IllegalTransition';
  }
}
