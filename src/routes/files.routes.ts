import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../errors";
import { failure } from "../utils/responses";

function userCanAccessChild(user: { id: string; role: string; childIds?: string[]; classes?: string[]; teacherId?: string }, child: Record<string, any> | undefined, teachers: Array<Record<string, any>>) {
  if (user.role === "admin") return true;
  if (!child) return false;
  if (user.role === "guardian") return Boolean(user.childIds?.includes(String(child.id)));
  if (user.role === "teacher") {
    const teacher = teachers.find((item) => String(item.id) === String(user.teacherId));
    const classes = user.classes ?? (Array.isArray(teacher?.classes) ? teacher.classes.map(String) : []);
    return classes.includes(String(child.className)) || (child.academicYears ?? []).some((year: Record<string, any>) => classes.includes(String(year.className)));
  }
  return false;
}

export function filesRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.post("/download", requireAuth(deps), async (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!key) throw new AppError(400, "A file key is required in the query string.", "FILE_KEY_REQUIRED");
    const store = await deps.repository.read();
    const file = store.files.find((item) => item.key === key);
    if (!file) return failure(res, 404, "The requested file could not be found.", "FILE_NOT_FOUND");
    const user = store.users.find((item) => item.id === req.authUser?.id);
    const child = store.children.find((item) => String(item.id) === file.childId);
    if (!user || !userCanAccessChild(user, child, store.teachers)) return failure(res, 404, "The requested file could not be found.", "FILE_NOT_FOUND");

    const storageRoot = path.resolve(deps.config.fileStorageDir);
    const fullPath = path.resolve(storageRoot, path.basename(file.storageName));
    if (!fullPath.startsWith(`${storageRoot}${path.sep}`)) throw new AppError(400, "Invalid file storage mapping.", "INVALID_FILE_MAPPING");
    try {
      await fs.access(fullPath);
    } catch {
      return failure(res, 404, "This file is not available on the server yet.", "FILE_NOT_AVAILABLE");
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    return res.download(fullPath, file.filename, (error) => {
      if (error && !res.headersSent) return failure(res, 500, "The file could not be downloaded.", "DOWNLOAD_FAILED");
    });
  });
  return router;
}
