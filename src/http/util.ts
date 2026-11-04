import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: string | null;
}

export const ok = <T>(res: Response, data: T, status = 200): void => {
  res.status(status).json({ success: true, data, error: null } satisfies ApiResponse<T>);
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Validate a request body at the boundary; a bad body is a 400 with the reason. */
export function body<T>(req: Request, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, `Invalid request: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new HttpError(400, `Invalid ${name}`);
  return v;
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** Wrap async handlers so a thrown error reaches the error middleware. */
export const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (status >= 500) process.stderr.write(`[backend] ${message}\n${err instanceof Error ? err.stack ?? "" : ""}\n`);
  res.status(status).json({ success: false, data: null, error: status >= 500 ? `Internal error: ${message}` : message } satisfies ApiResponse<null>);
}
