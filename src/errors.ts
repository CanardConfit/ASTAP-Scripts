export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: ErrorDetails;

  constructor(code: string, message: string, exitCode = 1, details?: ErrorDetails, cause?: unknown) {
    super(message, { cause });
    this.name = "AppError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const serializeError = (error: unknown) => {
  if (error instanceof AppError) {
    return {
      exitCode: error.exitCode,
      payload: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  const systemError = error as NodeJS.ErrnoException;
  if (systemError?.code && ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EROFS"].includes(systemError.code)) {
    return {
      exitCode: 7,
      payload: {
        ok: false,
        error: {
          code: "FILESYSTEM_ERROR",
          message: systemError.message,
          details: {
            systemCode: systemError.code,
            ...(systemError.path ? { path: systemError.path } : {}),
          },
        },
      },
    };
  }

  const apiError = error as { status?: unknown; message?: unknown };
  if (typeof apiError?.status === "number") {
    return {
      exitCode: 5,
      payload: {
        ok: false,
        error: {
          code: "GITHUB_API_ERROR",
          message: typeof apiError.message === "string" ? apiError.message : "The GitHub API request failed.",
          details: { httpStatus: apiError.status },
        },
      },
    };
  }

  return {
    exitCode: 1,
    payload: {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "An unknown error occurred.",
      },
    },
  };
};
