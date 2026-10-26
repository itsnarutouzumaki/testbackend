import { Router } from "express";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import { requireAuth } from "../middleware/auth";
import { buildAppData } from "../services/app-data.service";
import { failure } from "../utils/responses";

export function appDataRoutes(deps: { config: AppConfig; repository: JsonStoreRepository }) {
  const router = Router();
  router.get("/", requireAuth(deps), async (req, res) => {
    const state = await deps.repository.read();
    const user = state.users.find((entry) => entry.id === req.authUser?.id);
    if (!user) return failure(res, 401, "The session is no longer valid.", "INVALID_SESSION");
    return res.status(200).json({ success: true, data: buildAppData(state, user) });
  });
  return router;
}
