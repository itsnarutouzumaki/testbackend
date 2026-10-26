import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { AppConfig } from "../config";
import { JsonStoreRepository, StoreSizeLimitError } from "../repositories/json-store";
import type { PushMessage, PushOutcome } from "../services/push.service";
import { sendExpoPush } from "../services/push.service";
import { failure } from "../utils/responses";
import { safeStoreSnapshot } from "./admin.routes";

type DebugPushSender = (messages: PushMessage[], config: AppConfig) => Promise<PushOutcome>;

function unavailable(config: AppConfig, flag: boolean): boolean {
  return config.nodeEnv === "production" || !flag;
}

export function debugRoutes(deps: {
  config: AppConfig;
  repository: JsonStoreRepository;
  pushSender?: DebugPushSender;
}) {
  const router = Router();
  const pushTestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });

  router.get("/store-snapshot", async (_req, res, next) => {
    if (unavailable(deps.config, deps.config.debugStoreExportEnabled)) {
      return failure(res, 404, "This endpoint is not available.", "NOT_FOUND");
    }
    try {
      const store = await deps.repository.readLimited(deps.config.debugStoreMaxBytes);
      const response = JSON.stringify({ success: true, data: safeStoreSnapshot(store) });
      if (Buffer.byteLength(response, "utf8") > deps.config.debugStoreMaxBytes) {
        return failure(res, 413, "The sanitized store snapshot exceeds the configured export size limit.", "STORE_EXPORT_TOO_LARGE");
      }
      return res.type("application/json").status(200).send(response);
    } catch (error) {
      if (error instanceof StoreSizeLimitError) {
        return failure(res, 413, "The JSON store exceeds the configured export size limit.", "STORE_EXPORT_TOO_LARGE");
      }
      return next(error);
    }
  });

  router.get(
    "/send-test-notification",
    (_req, res, next) => {
      if (unavailable(deps.config, deps.config.debugPushTestEnabled)) {
        return failure(res, 404, "This endpoint is not available.", "NOT_FOUND");
      }
      next();
    },
    pushTestLimiter,
    async (req, res) => {
      const parsed = z.object({ to: z.string().trim().min(1).max(100) }).strict().safeParse(req.query);
      if (!parsed.success) return failure(res, 400, "Provide only one valid demo guardian ID in the `to` query parameter.", "INVALID_TEST_RECIPIENT");

      const store = await deps.repository.read();
      const guardian = store.users.find((user) =>
        user.id === parsed.data.to && user.role === "guardian" && user.isActive && user.id.startsWith("guardian-demo-")
      );
      if (!guardian) return failure(res, 404, "The demo guardian could not be found.", "DEMO_GUARDIAN_NOT_FOUND");

      const device = store.devices.find((entry) => entry.userId === guardian.id && entry.active && /^(Expo(nent)?PushToken)\[.+\]$/.test(entry.expoPushToken));
      if (!device) return failure(res, 404, "The demo guardian has no registered active Expo push token.", "TEST_PUSH_TOKEN_NOT_FOUND");

      const message: PushMessage = {
        to: device.expoPushToken,
        title: "Guardian School test notification",
        body: "This is a fixed test notification from the Guardian School backend.",
        sound: "default",
        priority: "high",
        channelId: "school-updates",
        data: { type: "debug_test_notification" }
      };
      const outcome = await (deps.pushSender ?? sendExpoPush)([message], deps.config);
      const expoHttpStatus = outcome.httpStatuses?.[0] ?? null;
      const accepted = outcome.acceptedTokens.includes(device.expoPushToken);
      if (!accepted) {
        return res.status(502).json({
          success: false,
          message: "Expo did not accept the test notification.",
          expoHttpStatus,
          accepted: false,
          deliveryConfirmed: false,
          ticketIds: outcome.ticketIds ?? []
        });
      }
      return res.status(200).json({
        success: true,
        message: "Expo accepted the test notification request; device delivery is not confirmed.",
        expoHttpStatus,
        accepted: true,
        deliveryConfirmed: false,
        ticketIds: outcome.ticketIds ?? []
      });
    }
  );

  return router;
}
