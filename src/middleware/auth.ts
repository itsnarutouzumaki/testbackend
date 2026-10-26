import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { AppError } from "../errors";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import type { UserRole } from "../types";
import { failure } from "../utils/responses";
import { logRequestError } from "./http-logging";

export interface AuthDeps {
  config: AppConfig;
  repository: JsonStoreRepository;
}

export function issueAccessToken(user: { id: string; role: UserRole; tokenVersion: number }, config: AppConfig): string {
  return jwt.sign({ role: user.role, tv: user.tokenVersion }, config.jwtSecret, {
    subject: user.id,
    expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"]
  });
}

export function requireAuth(deps: AuthDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header("authorization");
      const match = header?.match(/^Bearer\s+(.+)$/i);
      if (!match) throw new AppError(401, "Authentication is required.", "AUTH_REQUIRED");
      let decoded: jwt.JwtPayload;
      try {
        const result = jwt.verify(match[1]!, deps.config.jwtSecret);
        if (typeof result === "string") throw new Error("Invalid token payload");
        decoded = result;
      } catch {
        throw new AppError(401, "The session is invalid or expired. Please log in again.", "INVALID_SESSION");
      }
      if (!decoded.sub) throw new AppError(401, "The session is invalid. Please log in again.", "INVALID_SESSION");
      const store = await deps.repository.read();
      const user = store.users.find((entry) => entry.id === String(decoded.sub));
      if (!user || !user.isActive || Number(decoded.tv ?? -1) !== user.tokenVersion) {
        throw new AppError(401, "The session is no longer valid. Please log in again.", "SESSION_REVOKED");
      }
      req.authUser = { id: user.id, role: user.role, tokenVersion: user.tokenVersion };
      next();
    } catch (error) {
      if (error instanceof AppError) {
        logRequestError(req, error);
        return failure(res, error.status, error.message, error.code);
      }
      next(error);
    }
  };
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser) return failure(res, 401, "Authentication is required.", "AUTH_REQUIRED");
    if (!roles.includes(req.authUser.role)) return failure(res, 403, "You are not allowed to perform this action.", "FORBIDDEN");
    next();
  };
}
