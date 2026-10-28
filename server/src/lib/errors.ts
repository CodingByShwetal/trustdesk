export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GUARDRAIL_BLOCKED'
  | 'TOOL_EXECUTION_FAILED'
  | 'AI_PROVIDER_ERROR'
  | 'AI_PROVIDER_TIMEOUT'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GUARDRAIL_BLOCKED: 422,
  TOOL_EXECUTION_FAILED: 502,
  AI_PROVIDER_ERROR: 502,
  AI_PROVIDER_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

/** Domain error rendered by the API as { error: { code, message, details } }. */
export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS[code];
  }
}

export const notFound = (what: string, id: string) => new AppError('NOT_FOUND', `${what} '${id}' not found`);
