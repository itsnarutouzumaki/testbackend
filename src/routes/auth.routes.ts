import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { AppError } from "../errors";
import { issueAccessToken, requireAuth } from "../middleware/auth";
import { publicUser, sameEmail, samePhone, verifyPassword } from "../services/auth.service";
import { makeId, normalizeEmail, normalizePhone } from "../utils/ids";
import { failure, success } from "../utils/responses";
import { rateLimit } from "express-rate-limit";

const signupSchema = z.object({
  fullName: z.string().trim().min(2, "Full name must contain at least 2 characters.").max(100),
  email: z.string().trim().email("Enter a valid email address.").max(254),
  mobileNumber: z.string().trim().min(8, "Enter a valid mobile number.").max(25),
  password: z.string().min(8, "Password must contain at least 8 characters.").max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes."),
  address: z.string().trim().max(300).optional()
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Email or mobile number is required.").max(254),
  password: z.string().min(1, "Password is required.").max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password is too long.")
});

export function authRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" } });
  const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, message: "Too many signup attempts. Please try again later.", code: "RATE_LIMITED" } });

  router.post("/signup", signupLimiter, async (req, res) => {
    const input = signupSchema.parse(req.body);
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.mobileNumber);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const created = await deps.repository.mutate((store) => {
      if (store.users.some((user) => sameEmail(user.email, email))) throw new AppError(409, "An account with this email already exists.", "EMAIL_EXISTS");
      if (phone && store.users.some((user) => user.mobileNumber && samePhone(user.mobileNumber, phone))) throw new AppError(409, "An account with this mobile number already exists.", "MOBILE_EXISTS");
      const now = new Date().toISOString();
      const user = {
        id: makeId("guardian"),
        role: "guardian" as const,
        fullName: input.fullName,
        email,
        mobileNumber: input.mobileNumber,
        ...(input.address ? { address: input.address } : {}),
        profilePhotoUrl: null,
        relationship: "Parent",
        profileComplete: false,
        language: "en" as const,
        passwordHash,
        tokenVersion: 0,
        isActive: true,
        childIds: [] as string[],
        createdAt: now,
        updatedAt: now
      };
      store.users.push(user);
      return user;
    });
    const accessToken = issueAccessToken(created, deps.config);
    return res.status(201).json({ success: true, message: "Account created successfully.", accessToken, tokenType: "Bearer", user: publicUser(created) });
  });

  router.post("/change-password", loginLimiter, requireAuth(deps), async (req, res) => {
    const input = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8, "New password must contain at least 8 characters.").max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "New password must be at most 72 UTF-8 bytes.")
    }).refine((value) => value.currentPassword !== value.newPassword, "New password must be different from the current password.").parse(req.body);
    const newHash = await bcrypt.hash(input.newPassword, 12);
    await deps.repository.mutate(async (store) => {
      const user = store.users.find((entry) => entry.id === req.authUser?.id);
      if (!user || !user.isActive) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) throw new AppError(401, "Current password is incorrect.", "INVALID_CURRENT_PASSWORD");
      user.passwordHash = newHash;
      user.tokenVersion += 1;
      user.updatedAt = new Date().toISOString();
    });
    return res.status(200).json({ success: true, message: "Password updated successfully. Please log in again." });
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const identifier = input.identifier.trim();
    const store = await deps.repository.read();
    const user = store.users.find((candidate) => {
      if (identifier.includes("@")) return sameEmail(candidate.email, identifier);
      return Boolean(candidate.mobileNumber && samePhone(candidate.mobileNumber, identifier));
    });
    const valid = await verifyPassword(user, input.password);
    if (!valid || !user || !user.isActive) throw new AppError(401, "Incorrect login details.", "INVALID_CREDENTIALS");
    const accessToken = issueAccessToken(user, deps.config);
    return res.status(200).json({ success: true, message: "Login successful.", accessToken, tokenType: "Bearer", user: publicUser(user) });
  });

  return router;
}
