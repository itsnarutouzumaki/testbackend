import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/config";
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
  return { acceptedTokens: messages.map((message) => message.to), failedTokens: [], unregisteredTokens: [] };
};

async function login(identifier: string, password: string) {
  const response = await request(app).post("/api/v1/auth/login").send({ identifier, password });
  expect(response.status).toBe(200);
  return response.body.accessToken as string;
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
      demoAdminPassword: demoPasswords.admin
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
});
