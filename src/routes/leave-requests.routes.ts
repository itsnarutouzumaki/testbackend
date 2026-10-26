import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../errors";
import { assertGuardianChildAccess } from "../services/auth.service";
import { makeId } from "../utils/ids";
import { success } from "../utils/responses";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must use YYYY-MM-DD format.").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid date.");
const leaveSchema = z.object({
  childId: z.string().trim().min(1),
  startDate: dateString,
  endDate: dateString,
  reason: z.string().trim().min(1, "Leave reason is required.").max(1000, "Leave reason is too long."),
  password: z.string().min(1, "Password is required for leave request confirmation.").max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password is too long.")
});

export function leaveRequestRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.post("/", requireAuth(deps), async (req, res) => {
    const input = leaveSchema.parse(req.body);
    if (req.authUser?.role !== "guardian") throw new AppError(403, "Only guardians can submit leave requests.", "FORBIDDEN");
    if (input.endDate < input.startDate) throw new AppError(400, "End date must be on or after the start date.", "INVALID_DATE_RANGE");

    const idemKey = req.header("Idempotency-Key")?.trim();
    if (idemKey && idemKey.length > 200) throw new AppError(400, "Idempotency-Key must be at most 200 characters.", "INVALID_IDEMPOTENCY_KEY");
    const result = await deps.repository.mutate(async (store) => {
      const user = store.users.find((entry) => entry.id === req.authUser?.id);
      if (!user || !user.isActive) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
      assertGuardianChildAccess(user, input.childId);
      if (!store.children.some((child) => String(child.id) === input.childId)) throw new AppError(404, "The requested student could not be found.", "STUDENT_NOT_FOUND");

      const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
      if (!passwordValid) throw new AppError(401, "Incorrect password. Please try again.", "INVALID_PASSWORD");
      if (idemKey) {
        const previous = store.idempotency.find((entry) => entry.key === idemKey && entry.userId === user.id && entry.route === "POST /leave-requests");
        if (previous) return { duplicated: true as const };
      }
      store.leaveRequests.push({
        id: makeId("leave"), guardianId: user.id, childId: input.childId, startDate: input.startDate,
        endDate: input.endDate, reason: input.reason, status: "Pending", createdAt: new Date().toISOString()
      });
      if (idemKey) {
        store.idempotency.push({ key: idemKey, userId: user.id, route: "POST /leave-requests", resourceId: "created", createdAt: new Date().toISOString() });
        if (store.idempotency.length > 5000) store.idempotency = store.idempotency.slice(-4000);
      }
      return { duplicated: false as const };
    });

    if (result.duplicated) return success(res, 200, "This leave request was already processed.");
    return success(res, 201, "Leave request submitted successfully.");
  });
  return router;
}
