import type { Response } from "express";

export function success(res: Response, status: number, message: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ success: true, message, ...(extra ?? {}) });
}

export function failure(res: Response, status: number, message: string, code?: string) {
  return res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
}
