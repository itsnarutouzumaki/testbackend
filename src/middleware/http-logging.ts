import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

const MAX_LOGGED_BODY_CHARS = 4_000;
const CREDENTIAL_FIELD = /(password|passwd|passcode|authorization|cookie|token|jwt|secret|api.?key|private.?key|clientkey|accesskey|signingkey|encryptionkey|credential|salt|signature|^key$)/i;
const PERSONAL_FIELD = /^(fullname|firstname|lastname|email|identifier|mobilenumber|phone|phonenumber|address|studentname|admissionnumber|studentid|guardianname|guardianid|childid|userid|profilephotourl|reason|message|to)$/i;
const MAX_SANITIZE_DEPTH = 50;

function normalizedFieldName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(password|passwd|authorization|cookie|access[_-]?token|refresh[_-]?token|jwt|secret|api[_-]?key)\s*[:=]\s*["']?[^,\s"'}]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[REDACTED_PHONE]");
}

function sanitizeValue(value: unknown, hidePersonalData: boolean, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth >= MAX_SANITIZE_DEPTH) return "[MaxDepth]";
  if (typeof value === "string") return sanitizeText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, hidePersonalData, seen, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedFieldName(key);
    if (CREDENTIAL_FIELD.test(normalized)) {
      result[key] = "[REDACTED]";
    } else if (hidePersonalData && PERSONAL_FIELD.test(normalized)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeValue(child, hidePersonalData, seen, depth + 1);
    }
  }
  return result;
}

function boundedLogValue(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "[Unserializable]";
  }
  if (serialized === undefined) return "[Unserializable]";
  if (serialized.length <= MAX_LOGGED_BODY_CHARS) return JSON.parse(serialized) as unknown;
  return `${serialized.slice(0, MAX_LOGGED_BODY_CHARS)}...[truncated]`;
}

function requestIdFromHeader(value: string | undefined): string {
  if (value && /^[A-Za-z0-9._-]{1,128}$/.test(value)) return value;
  return randomUUID();
}

export function httpLoggingMiddleware(debugEnabled: boolean): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    const timestamp = new Date(startedAt).toISOString();
    const requestId = requestIdFromHeader(req.header("x-request-id"));
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const originalJson = res.json;
    let jsonResponse: unknown;
    res.json = function captureJson(body: unknown): Response {
      jsonResponse = body;
      return originalJson.call(this, body);
    };

    res.once("finish", () => {
      const log: Record<string, unknown> = {
        type: "http_request",
        requestId,
        method: req.method,
        path: sanitizeText(new URL(req.originalUrl, "http://localhost").pathname),
        timestamp,
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      };
      if (res.statusCode >= 400 && jsonResponse && typeof jsonResponse === "object" && "code" in jsonResponse) {
        log.errorCode = sanitizeText(String((jsonResponse as { code: unknown }).code));
      }
      const requestPath = new URL(req.originalUrl, "http://localhost").pathname;
      const isSnapshot = requestPath === "/api/v1/admin/debug/store-snapshot" || requestPath === "/api/v1/debug/store-snapshot";
      if (debugEnabled && !isSnapshot) {
        log.query = boundedLogValue(sanitizeValue(req.query, true));
        if (isJsonContentType(req.header("content-type") ?? "") && req.body !== undefined) {
          log.requestBody = boundedLogValue(sanitizeValue(req.body, true));
        }
        if (jsonResponse !== undefined && isJsonContentType(String(res.getHeader("content-type") ?? ""))) {
          log.responseBody = boundedLogValue(sanitizeValue(jsonResponse, true));
        }
      }
      console.log(JSON.stringify(log));
    });

    next();
  };
}

function isJsonContentType(contentType: string): boolean {
  return /^application\/(?:[^;]+\+)?json(?:\s*;|$)/i.test(contentType);
}

export function logRequestError(req: Request, error: unknown): void {
  const value = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({
    type: "http_error",
    requestId: req.res?.locals.requestId ?? "unassigned",
    method: req.method,
    path: sanitizeText(new URL(req.originalUrl, "http://localhost").pathname),
    error: { name: sanitizeText(value.name), message: sanitizeText(value.message).slice(0, 500) }
  }));
}
