import { Router } from "express";
import type { AppConfig } from "../config";
import { requireAuth, requireRoles } from "../middleware/auth";
import type { JsonStoreRepository } from "../repositories/json-store";
import { StoreSizeLimitError } from "../repositories/json-store";
import type { Store } from "../types";
import { failure } from "../utils/responses";

const CREDENTIAL_FIELD = /(password|passwd|passcode|authorization|cookie|token|jwt|secret|api.?key|private.?key|clientkey|accesskey|signingkey|encryptionkey|credential|salt|signature|^key$)/i;
const MAX_SNAPSHOT_DEPTH = 50;

function redactSnapshotValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SNAPSHOT_DEPTH) return "[MaxDepth]";
  if (Array.isArray(value)) return value.map((entry) => redactSnapshotValue(entry, depth + 1));
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
      .replace(/\b(password|passwd|authorization|cookie|access[_-]?token|refresh[_-]?token|jwt|secret|api[_-]?key)\s*[:=]\s*["']?[^,\s"'}]+/gi, "$1=[REDACTED]");
  }
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_FIELD.test(key) || /(base64|binary|buffer|filebytes|filedata|filecontent)/i.test(key)) continue;
    result[key] = redactSnapshotValue(child, depth + 1);
  }
  return result;
}

export function safeStoreSnapshot(store: Store): Store {
  const sanitized = redactSnapshotValue(store) as Store;
  sanitized.files = store.files.map((file) => {
    return {
      key: file.key,
      childId: file.childId,
      kind: file.kind,
      title: file.title,
      filename: file.filename,
      contentType: file.contentType,
      storageName: file.storageName,
      recordId: file.recordId,
      ...(file.academicYear === undefined ? {} : { academicYear: file.academicYear }),
      demoFixture: file.demoFixture
    };
  });
  return sanitized;
}

export function adminRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.get(
    "/debug/store-snapshot",
    (_req, res, next) => {
      if (!deps.config.debugStoreExportEnabled) return failure(res, 404, "This endpoint is not available.", "NOT_FOUND");
      next();
    },
    requireAuth(deps),
    requireRoles("admin"),
    async (_req, res) => {
      try {
        const store = await deps.repository.readLimited(deps.config.debugStoreMaxBytes);
        const snapshot = safeStoreSnapshot(store);
        const response = JSON.stringify({ success: true, data: snapshot });
        if (Buffer.byteLength(response, "utf8") > deps.config.debugStoreMaxBytes) {
          return failure(res, 413, "The sanitized store snapshot exceeds the configured export size limit.", "STORE_EXPORT_TOO_LARGE");
        }
        res.type("application/json");
        return res.status(200).send(response);
      } catch (error) {
        if (error instanceof StoreSizeLimitError) {
          return failure(res, 413, "The JSON store exceeds the configured export size limit.", "STORE_EXPORT_TOO_LARGE");
        }
        throw error;
      }
    }
  );
  return router;
}
