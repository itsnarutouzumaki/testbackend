import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors";
import { failure } from "../utils/responses";

export const notFoundHandler: RequestHandler = (req, res) => {
  failure(res, 404, `Endpoint not found: ${req.method} ${req.path}`, "NOT_FOUND");
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) return failure(res, error.status, error.message, error.code);
  if (error instanceof Error && error.message === "Origin is not permitted by CORS.") return failure(res, 403, "This origin is not allowed to call the API.", "CORS_ORIGIN_DENIED");
  if (error instanceof ZodError) return failure(res, 400, error.issues[0]?.message ?? "Request validation failed.", "VALIDATION_ERROR");
  if (error instanceof SyntaxError && "status" in error && (error as { status?: number }).status === 400) {
    return failure(res, 400, "Request body must contain valid JSON.", "INVALID_JSON");
  }
  console.error("Unhandled API error:", error);
  return failure(res, 500, "An unexpected server error occurred.", "INTERNAL_ERROR");
};
