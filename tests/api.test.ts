import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { debugRoutes } from "../src/routes/debug.routes";
import { httpLoggingMiddleware } from "../src/middleware/http-logging";
import { issueAccessToken } from "../src/middleware/auth";
import { JsonStoreRepository } from "../src/repositories/json-store";
import { createDemoStore } from "../src/services/demo-seed";
import type { PushOutcome } from "../src/services/push.service";
import type { Store } from "../src/types";

const demoPasswords = { guardian: "Demo@123", teacher: "DemoTeacher@123", admin: "DemoAdmin@123" };
let tmpDir = "";
let config: AppConfig;
let repository: JsonStoreRepository;
let initialStore: Store;
let app: ReturnType<typeof createApp>;
let pushMessages: Array<{ to: string; title: string; body: string; data: Record<string, unknown> }> = [];
const fakePushSender = async (messages: Array<{ to: string; title: string; body: string; sound: "default"; priority: "high"; channelId: string; data: Record<string, unknown> }>): Promise<PushOutcome> => {
  pushMessages.push(...messages);
  return {
    acceptedTokens: messages.map((message) => message.to),
    failedTokens: [],
    unregisteredTokens: [],
    httpStatuses: [200],
    ticketIds: ["expo-ticket-test-id"]
  };
};

async function login(identifier: string, password: string) {
  const response = await request(app).post("/api/v1/auth/login").send({ identifier, password });
  expect(response.status).toBe(200);
  return response.body.accessToken as string;
}

function tokenFor(email: string): string {
  const user = initialStore.users.find((entry) => entry.email === email);
  if (!user) throw new Error(`Missing test user: ${email}`);
  return issueAccessToken(user, config);
}

describe("Guardian School API", () => {
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-school-api-"));
    const fileDir = path.join(tmpDir, "files");
    await fs.mkdir(fileDir, { recursive: true });
    await fs.copyFile(path.resolve(process.cwd(), "storage/files/demo-fee-receipt.pdf"), path.join(fileDir, "demo-fee-receipt.pdf"));
    await fs.copyFile(path.resolve(process.cwd(), "storage/files/demo-test-copy.pdf"), path.join(fileDir, "demo-test-copy.pdf"));
    config = {
      nodeEnv: "test",
      port: 4000,
      jwtSecret: "test-secret-that-is-at-least-32-characters-long",
      jwtExpiresIn: "8h",
      corsOrigins: [],
      storePath: path.join(tmpDir, "store.json"),
      fileStorageDir: fileDir,
      enableDemoData: true,
      demoGuardianPassword: demoPasswords.guardian,
      demoTeacherPassword: demoPasswords.teacher,
      demoAdminPassword: demoPasswords.admin,
      httpDebugLogging: false,
      debugStoreExportEnabled: false,
      debugPushTestEnabled: false,
      debugStoreMaxBytes: 2 * 1024 * 1024
    };
    initialStore = await createDemoStore(config);
    repository = new JsonStoreRepository(config.storePath, async () => structuredClone(initialStore));
    await repository.replace(structuredClone(initialStore));
    app = createApp({ config, repository, pushSender: fakePushSender });
  }, 20000);

  beforeEach(async () => {
    await repository.replace(structuredClone(initialStore));
    pushMessages = [];
  });

  afterAll(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("logs in and returns the complete guardian-scoped app snapshot", async () => {
    const token = await login("priya.sharma@example.com", demoPasswords.guardian);
    const response = await request(app).get("/api/v1/app-data").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.guardian.id).toBe("guardian-demo-001");
    expect(response.body.data.children).toHaveLength(2);
    expect(response.body.data.teachers.length).toBeGreaterThan(0);
    expect(response.body.data.files.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    const phoneLogin = await request(app).post("/api/v1/auth/login").send({ identifier: "9876543210", password: demoPasswords.guardian });
    expect(phoneLogin.status).toBe(200);
  });

  it("keeps the health check publicly accessible", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body.success).toBe(true);
  });

  it("fails closed on a missing or incorrect leave password and stores no password", async () => {
    const token = await login("priya.sharma@example.com", demoPasswords.guardian);
    const base = { childId: "aarav", startDate: "2026-11-02", endDate: "2026-11-03", reason: "Medical appointment", password: demoPasswords.guardian };
    const noReason = await request(app).post("/api/v1/leave-requests").set("Authorization", `Bearer ${token}`).send({ ...base, reason: "   " });
    expect(noReason.status).toBe(400);
    const wrong = await request(app).post("/api/v1/leave-requests").set("Authorization", `Bearer ${token}`).send({ ...base, password: "wrong-password" });
    expect(wrong.status).toBe(401);
    const okay = await request(app).post("/api/v1/leave-requests").set("Authorization", `Bearer ${token}`).send(base);
    expect(okay.status).toBe(201);
    expect(Object.keys(okay.body).sort()).toEqual(["message", "success"]);
    const store = await repository.read();
    expect(store.leaveRequests).toHaveLength(initialStore.leaveRequests.length + 1);
    expect(JSON.stringify(store.leaveRequests)).not.toContain(demoPasswords.guardian);
  });

  it("returns only a message after a complaint write and persists it", async () => {
    const token = await login("priya.sharma@example.com", demoPasswords.guardian);
    const response = await request(app).post("/api/v1/complaints").set("Authorization", `Bearer ${token}`).send({ childId: "aarav", subject: "Transport issue", message: "The bus arrived late today." });
    expect(response.status).toBe(201);
    expect(Object.keys(response.body).sort()).toEqual(["message", "success"]);
    expect((await repository.read()).complaints).toHaveLength(initialStore.complaints.length + 1);
  });

  it("accepts an optional complaint attachment through the same endpoint", async () => {
    const token = await login("priya.sharma@example.com", demoPasswords.guardian);
    const response = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${token}`)
      .field("childId", "aarav")
      .field("subject", "Transport issue")
      .field("message", "The bus arrived late today.")
      .attach("attachment", path.resolve(process.cwd(), "storage/files/demo-fee-receipt.pdf"));
    expect(response.status).toBe(201);
    const store = await repository.read();
    const complaint = store.complaints.at(-1)!;
    expect(complaint.attachmentKey).toBeTruthy();
    expect(store.files.some((file) => file.key === complaint.attachmentKey && file.kind === "other")).toBe(true);
  });

  it("downloads a file by unique key only when the user has access", async () => {
    const store = await repository.read();
    const token = await login("priya.sharma@example.com", demoPasswords.guardian);
    const file = store.files.find((entry) => entry.childId === "aarav" && entry.kind === "fee_receipt")!;
    const response = await request(app).post(`/api/v1/files/download?key=${encodeURIComponent(file.key)}`).set("Authorization", `Bearer ${token}`).buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect((response.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("registers a device and dispatches a class announcement using each recipient's language", async () => {
    const adminToken = await login("admin@greenwood-demo.edu", demoPasswords.admin);
    const guardianToken = await login("priya.sharma@example.com", demoPasswords.guardian);
    await request(app).post("/api/v1/profile/language").set("Authorization", `Bearer ${guardianToken}`).send({ language: "hi" }).expect(200);
    await request(app).post("/api/v1/notifications/register-device").set("Authorization", `Bearer ${guardianToken}`).send({ expoPushToken: "ExpoPushToken[abcdefghijk123456789]", platform: "android" }).expect(200);
    const sent = await request(app).post("/api/v1/notifications/send").set("Authorization", `Bearer ${adminToken}`).send({
      subject: { en: "School holiday", hi: "विद्यालय में अवकाश" },
      content: { en: "School is closed tomorrow.", hi: "कल विद्यालय बंद रहेगा।" },
      audience: { type: "class", className: "Class 5", section: "A" }
    });
    expect(sent.status).toBe(202);
    expect(pushMessages).toHaveLength(1);
    expect(pushMessages[0]?.title).toBe("विद्यालय में अवकाश");
    expect(pushMessages[0]?.body).toBe("कल विद्यालय बंद रहेगा।");
    const updated = await repository.read();
    expect(updated.notifications.some((item) => item.userId === "guardian-demo-001" && item.titleHi === "विद्यालय में अवकाश" && !item.read)).toBe(true);
    expect(Object.keys(sent.body).sort()).toEqual(["message", "success"]);
  });

  it("prevents teachers from sending school-wide announcements", async () => {
    const token = await login("priya.sharma@greenwood-demo.edu", demoPasswords.teacher);
    const response = await request(app).post("/api/v1/notifications/send").set("Authorization", `Bearer ${token}`).send({
      subject: "Notice", content: "A message", audience: { type: "school" }
    });
    expect(response.status).toBe(403);
  });

  it("marks notifications as read and clears all unread state", async () => {
    const token = await login("priya.sharma@example.com", demoPasswords.guardian);
    const seeded = (await repository.read()).notifications.filter((item) => item.userId === "guardian-demo-001");
    await request(app).post("/api/v1/notifications/read").set("Authorization", `Bearer ${token}`).send({ notificationId: seeded[0]!.id }).expect(200);
    await request(app).post("/api/v1/notifications/read-all").set("Authorization", `Bearer ${token}`).send({}).expect(200);
    expect((await repository.read()).notifications.filter((item) => item.userId === "guardian-demo-001" && !item.read)).toHaveLength(0);
  });

  it("keeps store export disabled by default and requires authenticated administrator access when enabled", async () => {
    const pathName = "/api/v1/admin/debug/store-snapshot";
    await request(app).get(pathName).expect(404);

    config.debugStoreExportEnabled = true;
    await request(app).get(pathName).expect(401);
    await request(app).get(pathName).set("Authorization", "Bearer invalid-token").expect(401);
    const guardianToken = tokenFor("priya.sharma@example.com");
    const teacherToken = tokenFor("priya.sharma@greenwood-demo.edu");
    const adminToken = tokenFor("admin@greenwood-demo.edu");
    await request(app).get(pathName).set("Authorization", `Bearer ${guardianToken}`).expect(403);
    await request(app).get(pathName).set("Authorization", `Bearer ${teacherToken}`).expect(403);

    await repository.mutate((store) => {
      Object.assign(store.users[0]!, { debugCredentials: { nested: { refreshToken: "snapshot-secret" } } });
      Object.assign(store.files[0]!, { base64: "file-bytes-must-not-be-exported" });
    });
    const beforeSnapshot = await repository.read();
    const response = await request(app).get(pathName).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(response.body.data.users).toHaveLength(initialStore.users.length);
    expect(response.body.data.children).toHaveLength(initialStore.children.length);
    expect(response.body.data.files).toHaveLength(initialStore.files.length);
    expect(response.body.data.complaints).toEqual(initialStore.complaints);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("expoPushToken");
    expect(serialized).not.toContain(initialStore.users[0]!.passwordHash);
    expect(serialized).not.toContain("snapshot-secret");
    expect(serialized).not.toContain("file-bytes-must-not-be-exported");
    expect(response.body.data.files[0]).not.toHaveProperty("content");
    expect(response.body.data.files[0]).not.toHaveProperty("base64");
    expect(await repository.read()).toEqual(beforeSnapshot);
    config.debugStoreExportEnabled = false;
  });

  it("rejects store exports larger than the configured byte limit", async () => {
    config.debugStoreExportEnabled = true;
    const adminToken = tokenFor("admin@greenwood-demo.edu");
    config.debugStoreMaxBytes = 128;
    const response = await request(app)
      .get("/api/v1/admin/debug/store-snapshot")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(413);
    expect(response.body.code).toBe("STORE_EXPORT_TOO_LARGE");
    config.debugStoreMaxBytes = 2 * 1024 * 1024;
    config.debugStoreExportEnabled = false;
  });

  it("logs request and JSON response bodies with recursive credential and personal-data redaction", async () => {
    const loggingApp = express();
    loggingApp.use(express.json());
    loggingApp.use(httpLoggingMiddleware(true));
    loggingApp.post("/logging-test", (_req, res) => res.json({
      accessToken: "response-token",
      user: { email: "priya.sharma@example.com", fullName: "Priya Sharma" }
    }));
    loggingApp.post("/logging-large", (_req, res) => res.json({ result: "x".repeat(5_000) }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await request(loggingApp)
        .post("/logging-test?apiKey=do-not-log-this")
        .set("X-Request-Id", "test-request-123")
        .send({ identifier: "priya.sharma@example.com", password: demoPasswords.guardian, nested: { accessToken: "nested-token" } });
      expect(response.status).toBe(200);
      expect(response.headers["x-request-id"]).toBe("test-request-123");
      const logLines = log.mock.calls.map(([line]) => String(line));
      const requestLog = logLines.map((line) => JSON.parse(line) as Record<string, any>).find((entry) => entry.type === "http_request")!;
      expect(requestLog.requestId).toBe("test-request-123");
      expect(requestLog.requestBody.password).toBe("[REDACTED]");
      expect(requestLog.requestBody.nested.accessToken).toBe("[REDACTED]");
      expect(requestLog.query.apiKey).toBe("[REDACTED]");
      expect(requestLog.responseBody.accessToken).toBe("[REDACTED]");
      expect(logLines.join("\n")).not.toContain(demoPasswords.guardian);
      expect(logLines.join("\n")).not.toContain("priya.sharma@example.com");

      await request(loggingApp).post("/logging-large").send({ payload: "y".repeat(5_000) }).expect(200);
      const largeLog = log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, any>)
        .find((entry) => entry.path === "/logging-large")!;
      expect(largeLog.requestBody).toContain("...[truncated]");
      expect(largeLog.responseBody).toContain("...[truncated]");
    } finally {
      log.mockRestore();
    }
  });

  it("does not log binary file downloads or include the store snapshot body in logs", async () => {
    const debugApp = createApp({ config: { ...config, httpDebugLogging: true, debugStoreExportEnabled: true }, repository });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const adminToken = tokenFor("admin@greenwood-demo.edu");
      const guardianToken = tokenFor("priya.sharma@example.com");
      const file = (await repository.read()).files.find((entry) => entry.childId === "aarav")!;
      await request(debugApp).post(`/api/v1/files/download?key=${encodeURIComponent(file.key)}`).set("Authorization", `Bearer ${guardianToken}`).expect(200);
      await request(debugApp).get("/api/v1/admin/debug/store-snapshot").set("Authorization", `Bearer ${adminToken}`).expect(200);
      const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, any>);
      const downloadLog = entries.find((entry) => entry.path === "/api/v1/files/download");
      const snapshotLog = entries.find((entry) => entry.path === "/api/v1/admin/debug/store-snapshot");
      expect(downloadLog).not.toHaveProperty("responseBody");
      expect(snapshotLog).not.toHaveProperty("responseBody");
      expect(JSON.stringify(snapshotLog)).not.toContain("passwordHash");
    } finally {
      log.mockRestore();
      config.debugStoreExportEnabled = false;
    }
  });

  it("serves a redacted browser snapshot only when enabled outside production", async () => {
    const pathName = "/api/v1/debug/store-snapshot";
    await request(app).get(pathName).expect(404);

    config.debugStoreExportEnabled = true;
    await repository.mutate((store) => {
      Object.assign(store.school, { nested: { apiSecret: "private-secret", authorization: "Bearer abc.def.ghi" } });
      Object.assign(store.users[0]!, { nestedCredentials: { refreshToken: "private-token" } });
      Object.assign(store.files[0]!, { binaryData: "must-not-be-exported" });
    });
    const before = await repository.read();
    const response = await request(app).get(pathName).expect(200);
    expect(response.body.data.users).toHaveLength(initialStore.users.length);
    expect(response.body.data.notifications).toEqual(initialStore.notifications);
    expect(response.body.data.school.nested).not.toHaveProperty("apiSecret");
    expect(response.body.data.school.nested).not.toHaveProperty("authorization");
    expect(response.body.data.users[0]).not.toHaveProperty("passwordHash");
    expect(response.body.data.users[0]).not.toHaveProperty("nestedCredentials");
    expect(response.body.data.files[0]).not.toHaveProperty("binaryData");
    expect(JSON.stringify(response.body)).not.toContain("private-secret");
    expect(JSON.stringify(response.body)).not.toContain("private-token");
    expect(JSON.stringify(response.body)).not.toContain("must-not-be-exported");
    expect(await repository.read()).toEqual(before);

    config.nodeEnv = "production";
    await request(app).get(pathName).expect(404);
    config.nodeEnv = "test";
    config.debugStoreExportEnabled = false;
  });

  it("sends only a fixed test push to an active demo guardian token when enabled", async () => {
    const pathName = "/api/v1/debug/send-test-notification";
    await request(app).get(`${pathName}?to=guardian-demo-001`).expect(404);

    config.debugPushTestEnabled = true;
    await request(app).get(`${pathName}?to=guardian-demo-001`).expect(404);
    const expoToken = "ExpoPushToken[abcdefghijk123456789]";
    await repository.mutate((store) => {
      store.devices.push({
        id: "test-device",
        userId: "guardian-demo-001",
        expoPushToken: expoToken,
        platform: "android",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        active: true
      });
    });
    const sent = await request(app).get(`${pathName}?to=guardian-demo-001`).expect(200);
    expect(sent.body).toMatchObject({
      success: true,
      expoHttpStatus: 200,
      accepted: true,
      deliveryConfirmed: false,
      ticketIds: ["expo-ticket-test-id"]
    });
    expect(JSON.stringify(sent.body)).not.toContain(expoToken);
    expect(pushMessages).toHaveLength(1);
    expect(pushMessages[0]).toMatchObject({
      to: expoToken,
      title: "Guardian School test notification",
      body: "This is a fixed test notification from the Guardian School backend."
    });
    const failedPushApp = express();
    failedPushApp.use("/api/v1/debug", debugRoutes({
      config,
      repository,
      pushSender: async () => ({
        acceptedTokens: [],
        failedTokens: [expoToken],
        unregisteredTokens: [],
        httpStatuses: [503]
      })
    }));
    const failed = await request(failedPushApp).get(`${pathName}?to=guardian-demo-001`).expect(502);
    expect(failed.body).toMatchObject({ success: false, expoHttpStatus: 503, accepted: false, deliveryConfirmed: false });
    await request(app).get(`${pathName}?to=guardian-demo-001&body=custom`).expect(400);
    await request(app).get(`${pathName}?to=admin-demo`).expect(404);

    config.nodeEnv = "production";
    await request(app).get(`${pathName}?to=guardian-demo-001`).expect(404);
    config.nodeEnv = "test";
    config.debugPushTestEnabled = false;
  });
});
