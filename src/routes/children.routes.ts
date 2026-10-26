import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { requireAuth, requireRoles } from "../middleware/auth";
import { AppError } from "../errors";
import { makeId } from "../utils/ids";
import { success } from "../utils/responses";

export function childrenRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.post("/link-requests", requireAuth(deps), async (req, res) => {
    const { studentId, studentName } = z.object({
      studentId: z.string().trim().min(2).max(100),
      studentName: z.string().trim().min(2).max(100)
    }).parse(req.body);
    if (req.authUser?.role !== "guardian") throw new AppError(403, "Only guardians can request child access.", "FORBIDDEN");
    await deps.repository.mutate((store) => {
      const user = store.users.find((entry) => entry.id === req.authUser?.id);
      if (!user) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
      const needle = studentId.trim().toLowerCase();
      const child = store.children.find((item) => [item.studentId, item.admissionNumber, item.id].some((value) => String(value ?? "").toLowerCase() === needle));
      if (!child || String(child.fullName ?? "").trim().toLowerCase() !== studentName.trim().toLowerCase()) {
        throw new AppError(404, "Student details could not be verified. Check the student ID and full name.", "STUDENT_DETAILS_NOT_FOUND");
      }
      if (user.childIds?.includes(String(child.id))) throw new AppError(409, "This student is already linked to your account.", "STUDENT_ALREADY_LINKED");
      const canonicalStudentId = String(child.studentId ?? child.id);
      const pending = store.linkRequests.some((request) => request.guardianId === user.id && request.studentId === canonicalStudentId && request.status.toLowerCase() === "pending");
      if (pending) throw new AppError(409, "A request for this student is already pending.", "LINK_REQUEST_EXISTS");
      store.linkRequests.push({ id: makeId("link"), guardianId: user.id, studentId: canonicalStudentId, studentName: String(child.fullName ?? studentName), status: "Pending", createdAt: new Date().toISOString() });
    });
    return success(res, 201, "Child access request submitted for school review.");
  });

  router.post("/link-requests/:requestId/decision", requireAuth(deps), requireRoles("admin"), async (req, res) => {
    const { decision } = z.object({ decision: z.enum(["approve", "reject"]) }).parse(req.body);
    await deps.repository.mutate((store) => {
      const request = store.linkRequests.find((entry) => entry.id === req.params.requestId);
      if (!request) throw new AppError(404, "Link request could not be found.", "LINK_REQUEST_NOT_FOUND");
      if (request.status.toLowerCase() !== "pending") throw new AppError(409, "This link request has already been reviewed.", "LINK_REQUEST_REVIEWED");
      if (decision === "approve") {
        const child = store.children.find((entry) => String(entry.studentId ?? entry.id) === request.studentId || String(entry.id) === request.studentId);
        const guardian = store.users.find((entry) => entry.id === request.guardianId);
        if (!child || !guardian) throw new AppError(404, "The linked records could not be found.", "LINK_TARGET_NOT_FOUND");
        guardian.childIds = [...new Set([...(guardian.childIds ?? []), String(child.id)])];
        request.status = "Approved";
      } else request.status = "Rejected";
    });
    return success(res, 200, decision === "approve" ? "Child access request approved." : "Child access request rejected.");
  });
  return router;
}
