import type { AppConfig } from "../config";
import type { JsonStoreRepository } from "../repositories/json-store";
import type { DeviceRegistration, LocalizedText, NotificationRecord, User } from "../types";
import type { PushMessage, PushOutcome } from "./push.service";
import { sendExpoPush } from "./push.service";
import { makeId } from "../utils/ids";
import { AppError } from "../errors";

export type Audience =
  | { type: "school" }
  | { type: "all_guardians" }
  | { type: "all_teachers" }
  | { type: "class"; className: string; section?: string }
  | { type: "guardian_ids"; ids: string[] }
  | { type: "teacher_ids"; ids: string[] };

export function localized(value: LocalizedText, language: "en" | "hi"): string {
  if (typeof value === "string") return value;
  const selected = language === "hi" ? value.hi : value.en;
  return (selected ?? value.en ?? value.hi ?? "").trim();
}

function childClassMatches(child: Record<string, any>, className: string, section?: string): boolean {
  const currentClass = String(child.className ?? child.academicYears?.[0]?.className ?? "");
  const currentSection = String(child.section ?? child.academicYears?.[0]?.section ?? "");
  return currentClass === className && (!section || currentSection === section);
}

function resolveRecipients(store: Awaited<ReturnType<JsonStoreRepository["read"]>>, sender: User, audience: Audience): User[] {
  const active = store.users.filter((user) => user.isActive);
  if (audience.type === "school") {
    if (sender.role !== "admin") throw new AppError(403, "Only an administrator can notify the whole school.", "FORBIDDEN_AUDIENCE");
    return active.filter((user) => user.role === "guardian" || user.role === "teacher");
  }
  if (audience.type === "all_guardians") {
    if (sender.role !== "admin") throw new AppError(403, "Only an administrator can notify all guardians.", "FORBIDDEN_AUDIENCE");
    return active.filter((user) => user.role === "guardian");
  }
  if (audience.type === "all_teachers") {
    if (sender.role !== "admin") throw new AppError(403, "Only an administrator can notify all teachers.", "FORBIDDEN_AUDIENCE");
    return active.filter((user) => user.role === "teacher");
  }
  if (audience.type === "guardian_ids") {
    if (sender.role !== "admin") throw new AppError(403, "Only an administrator can select individual guardians.", "FORBIDDEN_AUDIENCE");
    const wanted = new Set(audience.ids);
    return active.filter((user) => user.role === "guardian" && wanted.has(user.id));
  }
  if (audience.type === "teacher_ids") {
    if (sender.role !== "admin") throw new AppError(403, "Only an administrator can select individual teachers.", "FORBIDDEN_AUDIENCE");
    const wanted = new Set(audience.ids);
    return active.filter((user) => user.role === "teacher" && wanted.has(user.id));
  }
  if (audience.type === "class") {
    if (sender.role === "teacher" && !(sender.classes ?? []).includes(audience.className)) {
      throw new AppError(403, "You can only send class notifications to classes assigned to you.", "FORBIDDEN_AUDIENCE");
    }
    if (sender.role !== "teacher" && sender.role !== "admin") throw new AppError(403, "You are not allowed to send class notifications.", "FORBIDDEN_AUDIENCE");
    const childIds = new Set(store.children.filter((child) => childClassMatches(child, audience.className, audience.section)).map((child) => String(child.id)));
    return active.filter((user) => user.role === "guardian" && (user.childIds ?? []).some((id) => childIds.has(id)));
  }
  return [];
}

export async function dispatchNotification(input: {
  repository: JsonStoreRepository;
  config: AppConfig;
  sender: User;
  audience: Audience;
  subject: LocalizedText;
  content: LocalizedText;
  sendPush?: (messages: PushMessage[], config: AppConfig) => Promise<PushOutcome>;
}) {
  const plan = await input.repository.mutate((store) => {
    const sender = store.users.find((user) => user.id === input.sender.id);
    if (!sender || !sender.isActive) throw new AppError(401, "The session is no longer valid.", "INVALID_SESSION");
    const recipients = resolveRecipients(store, sender, input.audience);
    if (!recipients.length) throw new AppError(400, "No active recipients matched this audience.", "NO_RECIPIENTS");
    const deviceTokensByUser = new Map<string, DeviceRegistration[]>();
    for (const recipient of recipients) {
      const devices = store.devices.filter((device) => device.userId === recipient.id && device.active);
      deviceTokensByUser.set(recipient.id, devices);
    }
    const messages: PushMessage[] = [];
    const notificationIdsByUser = new Map<string, string>();
    for (const recipient of recipients) {
      const titleEn = localized(input.subject, "en");
      const messageEn = localized(input.content, "en");
      const titleHi = localized(input.subject, "hi");
      const messageHi = localized(input.content, "hi");
      const title = recipient.language === "hi" ? titleHi : titleEn;
      const message = recipient.language === "hi" ? messageHi : messageEn;
      const id = makeId("ntf");
      notificationIdsByUser.set(recipient.id, id);
      const devices = deviceTokensByUser.get(recipient.id) ?? [];
      store.notifications.push({
        id,
        userId: recipient.id,
        title,
        message,
        titleEn,
        messageEn,
        titleHi,
        messageHi,
        type: "announcement",
        audienceType: input.audience.type,
        read: false,
        createdAt: new Date().toISOString(),
        pushStatus: devices.length ? "not_attempted" : "no_devices"
      });
      for (const device of devices) {
        messages.push({
          to: device.expoPushToken,
          title,
          body: message,
          sound: "default",
          priority: "high",
          channelId: "school-updates",
          data: { type: "school_announcement", notificationId: id, route: "Notifications" }
        });
      }
    }
    return {
      recipientIds: recipients.map((recipient) => recipient.id),
      messages,
      notificationIdsByUser,
      deviceUserByToken: new Map(store.devices.filter((device) => device.active).map((device) => [device.expoPushToken, device.userId]))
    };
  });

  if (!plan.messages.length) return { recipients: plan.recipientIds.length, accepted: 0, failed: 0, noDevices: plan.recipientIds.length };
  const outcome = await (input.sendPush ?? sendExpoPush)(plan.messages, input.config);
  const acceptedSet = new Set(outcome.acceptedTokens);
  const failedSet = new Set(outcome.failedTokens);
  const invalidSet = new Set(outcome.unregisteredTokens);
  await input.repository.mutate((store) => {
    const newNotificationIds = new Set(plan.notificationIdsByUser.values());
    for (const notification of store.notifications) {
      if (!newNotificationIds.has(notification.id)) continue;
      const userTokens = store.devices.filter((device) => device.userId === notification.userId && device.active).map((device) => device.expoPushToken);
      if (userTokens.some((token) => acceptedSet.has(token))) notification.pushStatus = "accepted";
      else if (userTokens.some((token) => failedSet.has(token))) notification.pushStatus = "failed";
    }
    for (const device of store.devices) {
      if (invalidSet.has(device.expoPushToken)) device.active = false;
    }
  });
  const recipientWithSuccess = new Set(outcome.acceptedTokens.map((token) => plan.deviceUserByToken.get(token)).filter(Boolean));
  const recipientWithFailure = new Set(outcome.failedTokens.map((token) => plan.deviceUserByToken.get(token)).filter(Boolean));
  return {
    recipients: plan.recipientIds.length,
    accepted: recipientWithSuccess.size,
    failed: recipientWithFailure.size,
    noDevices: Math.max(0, plan.recipientIds.length - new Set([...recipientWithSuccess, ...recipientWithFailure]).size)
  };
}

export { resolveRecipients };
