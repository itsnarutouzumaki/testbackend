import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../errors";
import { success } from "../utils/responses";

const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  profilePhotoUrl: z.union([z.string().url().max(2000), z.null()]).optional()
}).refine((value) => value.fullName !== undefined || value.profilePhotoUrl !== undefined, "Provide at least one editable profile field.");

export function profileRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.post("/update", requireAuth(deps), async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    await deps.repository.mutate((store) => {
      const user = store.users.find((entry) => entry.id === req.authUser?.id);
      if (!user) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
      if (input.fullName !== undefined) user.fullName = input.fullName;
      if (input.profilePhotoUrl !== undefined) user.profilePhotoUrl = input.profilePhotoUrl;
      user.profileComplete = Boolean(user.fullName.trim() && user.mobileNumber && user.email && user.profilePhotoUrl);
      user.updatedAt = new Date().toISOString();
    });
    return success(res, 200, "Profile updated successfully.");
  });

  router.post("/language", requireAuth(deps), async (req, res) => {
    const input = z.object({ language: z.enum(["en", "hi"]) }).parse(req.body);
    await deps.repository.mutate((store) => {
      const user = store.users.find((entry) => entry.id === req.authUser?.id);
      if (!user) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
      user.language = input.language;
      user.updatedAt = new Date().toISOString();
    });
    return success(res, 200, "Language preference updated successfully.");
  });
  return router;
}
