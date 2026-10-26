import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import type { PushOutcome } from "../services/push.service";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../errors";
import { dispatchNotification } from "../services/notification.service";
import { makeId } from "../utils/ids";
import { success } from "../utils/responses";

const localizedTextSchema = z.union([
  z.string().trim().min(1).max(4000),
  z.object({ en: z.string().trim().min(1).max(4000).optional(), hi: z.string().trim().min(1).max(4000).optional() })
    .refine((value) => Boolean(value.en || value.hi), "Provide at least one language value.")
]);
const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("school") }),
  z.object({ type: z.literal("all_guardians") }),
  z.object({ type: z.literal("all_teachers") }),
  z.object({ type: z.literal("class"), className: z.string().trim().min(1).max(80), section: z.string().trim().min(1).max(20).optional() }),
  z.object({ type: z.literal("guardian_ids"), ids: z.array(z.string().trim().min(1)).min(1).max(500) }),
  z.object({ type: z.literal("teacher_ids"), ids: z.array(z.string().trim().min(1)).min(1).max(200) })
]);
const sendSchema = z.object({ subject: localizedTextSchema, content: localizedTextSchema, audience: audienceSchema });
const deviceSchema = z.object({
  expoPushToken: z.string().trim().min(15).max(300).regex(/^(Expo(nent)?PushToken)\[.+\]$/, "Use a valid Expo push token."),
  platform: z.enum(["ios", "android", "unknown"]).default("unknown"),
  deviceId: z.string().trim().max(200).optional()
});
const readSchema = z.object({ notificationId: z.string().trim().min(1).max(200) });

export type PushSender = (messages: Array<{ to: string; title: string; body: string; sound: "default"; priority: "high"; channelId: string; data: Record<string, unknown> }>, config: AppConfig) => Promise<PushOutcome>;

export function notificationRoutes(deps: { config: AppConfig; repository: JsonStoreRepository; pushSender?: PushSender }) {
  const router = Router();

  router.post("/register-device", requireAuth(deps), async (req, res) => {
    const input = deviceSchema.parse(req.body);
    await deps.repository.mutate((store) => {
      const existing = store.devices.find((device) => device.expoPushToken === input.expoPushToken);
      const now = new Date().toISOString();
      if (existing) {
        existing.userId = req.authUser!.id;
        existing.platform = input.platform;
        if (input.deviceId !== undefined) existing.deviceId = input.deviceId;
        existing.updatedAt = now;
        existing.active = true;
      } else {
        store.devices.push({ id: makeId("device"), userId: req.authUser!.id, expoPushToken: input.expoPushToken, platform: input.platform, ...(input.deviceId ? { deviceId: input.deviceId } : {}), createdAt: now, updatedAt: now, active: true });
      }
    });
    return success(res, 200, "Device registered for notifications.");
  });

  router.post("/unregister-device", requireAuth(deps), async (req, res) => {
    const input = z.object({ expoPushToken: deviceSchema.shape.expoPushToken }).parse(req.body);
    await deps.repository.mutate((store) => {
      for (const device of store.devices) {
        if (device.userId === req.authUser?.id && device.expoPushToken === input.expoPushToken) {
          device.active = false;
          device.updatedAt = new Date().toISOString();
        }
      }
    });
    return success(res, 200, "Device unregistered from notifications.");
  });

  router.post("/read", requireAuth(deps), async (req, res) => {
    const input = readSchema.parse(req.body);
    await deps.repository.mutate((store) => {
      const notification = store.notifications.find((item) => item.id === input.notificationId && item.userId === req.authUser?.id);
      if (!notification) throw new AppError(404, "Notification could not be found.", "NOTIFICATION_NOT_FOUND");
      notification.read = true;
    });
    return success(res, 200, "Notification marked as read.");
  });

  router.post("/read-all", requireAuth(deps), async (req, res) => {
    await deps.repository.mutate((store) => {
      for (const notification of store.notifications) if (notification.userId === req.authUser?.id) notification.read = true;
    });
    return success(res, 200, "All notifications marked as read.");
  });

  router.post("/send", requireAuth(deps), async (req, res) => {
    if (req.authUser?.role !== "admin" && req.authUser?.role !== "teacher") throw new AppError(403, "Only administrators and teachers can send announcements.", "FORBIDDEN");
    const input = sendSchema.parse(req.body);
    const store = await deps.repository.read();
    const sender = store.users.find((user) => user.id === req.authUser?.id);
    if (!sender) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
    const result = await dispatchNotification({
      repository: deps.repository,
      config: deps.config,
      sender,
      audience: input.audience,
      subject: input.subject,
      content: input.content,
      ...(deps.pushSender ? { sendPush: deps.pushSender } : {})
    });
    if (result.noDevices === result.recipients) {
      return success(res, 202, `Notification saved for ${result.recipients} recipients; no registered push devices were available.`);
    }
    if (result.failed > 0) {
      return success(res, 202, `Notification saved. Push was accepted for ${result.accepted} recipients; delivery could not be confirmed for some devices.`);
    }
    return success(res, 202, `Notification saved and push dispatch accepted for ${result.accepted} recipients.`);
  });

  return router;
}
