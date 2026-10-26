import { Router, type RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../errors";
import { assertGuardianChildAccess } from "../services/auth.service";
import { makeId } from "../utils/ids";
import { success } from "../utils/responses";

const complaintSchema = z.object({
  childId: z.string().trim().min(1),
  subject: z.string().trim().max(120).optional(),
  message: z.string().trim().min(8, "Complaint details must contain at least 8 characters.").max(5000),
  category: z.string().trim().max(80).optional(),
  attachmentKey: z.string().trim().max(200).optional()
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) {
      return callback(new AppError(400, "Attachment must be a PDF, JPG or PNG file.", "UNSUPPORTED_ATTACHMENT"));
    }
    callback(null, true);
  }
});
const uploadSingle = upload.single("attachment");
const handleUpload: RequestHandler = (req, res, next) => uploadSingle(req, res, (error) => {
  if (!error) return next();
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return next(new AppError(413, "Attachment must be 5 MB or smaller.", "ATTACHMENT_TOO_LARGE"));
  if (error instanceof AppError) return next(error);
  return next(new AppError(400, "Attachment could not be processed.", "INVALID_ATTACHMENT"));
});

function validateFileContent(file: Express.Multer.File): { extension: string; contentType: string } {
  const data = file.buffer;
  if (file.mimetype === "application/pdf" && data.subarray(0, 5).toString("ascii") === "%PDF-") return { extension: ".pdf", contentType: "application/pdf" };
  if (file.mimetype === "image/png" && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: ".png", contentType: "image/png" };
  if (file.mimetype === "image/jpeg" && data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return { extension: ".jpg", contentType: "image/jpeg" };
  throw new AppError(400, "Attachment content does not match its file type.", "INVALID_ATTACHMENT_CONTENT");
}

function safeFileName(value: string): string {
  const name = path.basename(value).replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  return name.slice(0, 120) || "complaint-attachment";
}

export function complaintsRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.post("/", requireAuth(deps), handleUpload, async (req, res) => {
    const input = complaintSchema.parse(req.body);
    if (req.authUser?.role !== "guardian") throw new AppError(403, "Only guardians can submit complaints.", "FORBIDDEN");
    if (req.file && input.attachmentKey) throw new AppError(400, "Provide either an uploaded attachment or an existing attachment key, not both.", "DUPLICATE_ATTACHMENT_SOURCE");

    const userSnapshot = await deps.repository.read();
    const preflightUser = userSnapshot.users.find((entry) => entry.id === req.authUser?.id);
    if (!preflightUser) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
    assertGuardianChildAccess(preflightUser, input.childId);
    if (!userSnapshot.children.some((entry) => String(entry.id) === input.childId)) throw new AppError(404, "The requested student could not be found.", "STUDENT_NOT_FOUND");
    if (input.attachmentKey && !userSnapshot.files.some((file) => file.key === input.attachmentKey && file.childId === input.childId)) {
      throw new AppError(400, "The selected attachment is invalid.", "INVALID_ATTACHMENT");
    }

    const complaintId = makeId("cmp");
    let uploadedFile: { key: string; storageName: string; filename: string; contentType: string } | undefined;
    let writtenPath: string | undefined;
    if (req.file) {
      const verified = validateFileContent(req.file);
      const key = makeId("cmpfile");
      const storageName = `${key}${verified.extension}`;
      const filename = safeFileName(req.file.originalname);
      const storageRoot = path.resolve(deps.config.fileStorageDir);
      writtenPath = path.resolve(storageRoot, storageName);
      await fs.mkdir(storageRoot, { recursive: true });
      await fs.writeFile(writtenPath, req.file.buffer, { flag: "wx", mode: 0o600 });
      uploadedFile = { key, storageName, filename, contentType: verified.contentType };
    }

    try {
      await deps.repository.mutate((store) => {
        const user = store.users.find((entry) => entry.id === req.authUser?.id);
        if (!user) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
        assertGuardianChildAccess(user, input.childId);
        if (!store.children.some((entry) => String(entry.id) === input.childId)) throw new AppError(404, "The requested student could not be found.", "STUDENT_NOT_FOUND");
        if (input.attachmentKey && !store.files.some((file) => file.key === input.attachmentKey && file.childId === input.childId)) {
          throw new AppError(400, "The selected attachment is invalid.", "INVALID_ATTACHMENT");
        }
        store.complaints.push({
          id: complaintId,
          guardianId: user.id,
          childId: input.childId,
          subject: input.subject?.trim() || "General",
          message: input.message,
          ...(input.category ? { category: input.category } : {}),
          ...(uploadedFile ? { attachmentKey: uploadedFile.key, attachmentName: uploadedFile.filename } : input.attachmentKey ? {
            attachmentKey: input.attachmentKey,
            attachmentName: store.files.find((file) => file.key === input.attachmentKey)?.filename
          } : {}),
          status: "Submitted",
          createdAt: new Date().toISOString()
        });
        if (uploadedFile) {
          store.files.push({
            key: uploadedFile.key,
            childId: input.childId,
            kind: "other",
            title: `Complaint attachment - ${input.subject?.trim() || "General"}`,
            filename: uploadedFile.filename,
            contentType: uploadedFile.contentType,
            storageName: uploadedFile.storageName,
            recordId: complaintId,
            demoFixture: false
          });
        }
      });
    } catch (error) {
      if (writtenPath) await fs.rm(writtenPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return success(res, 201, "Complaint submitted successfully.");
  });
  return router;
}
