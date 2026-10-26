import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { AppConfig } from "../config";
import type { Store, User, FileRecord } from "../types";
import { makeId } from "../utils/ids";

const seedDir = path.resolve(process.cwd(), "data/seed");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(seedDir, name), "utf8")) as T;
}

const safePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

function attachFileKeys(children: Array<Record<string, any>>, files: FileRecord[]) {
  for (const child of children) {
    for (const year of child.academicYears ?? []) {
      for (const receipt of year.feeReceipts ?? []) {
        const key = `fr_${safePart(String(receipt.id))}`;
        receipt.fileKey = key;
        files.push({
          key,
          childId: String(child.id),
          kind: "fee_receipt",
          title: `${receipt.label ?? "Fee"} fee receipt (${year.label})`,
          filename: `fee-receipt-${safePart(String(receipt.id))}.pdf`,
          contentType: "application/pdf",
          storageName: "demo-fee-receipt.pdf",
          recordId: String(receipt.id),
          academicYear: String(year.label ?? ""),
          demoFixture: true
        });
      }
      for (const subject of year.subjects ?? []) {
        for (const test of subject.tests ?? []) {
          if (!test.copyAvailable) continue;
          const key = `tc_${safePart(String(test.id))}`;
          test.fileKey = key;
          files.push({
            key,
            childId: String(child.id),
            kind: "test_copy",
            title: `${test.name ?? "Test"} copy - ${subject.name ?? "Subject"} (${year.label})`,
            filename: `test-copy-${safePart(String(test.id))}.pdf`,
            contentType: "application/pdf",
            storageName: "demo-test-copy.pdf",
            recordId: String(test.id),
            academicYear: String(year.label ?? ""),
            demoFixture: true
          });
        }
      }
    }
  }
}

function timestamp(value?: string): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function createEmptyStore(): Promise<Store> {
  const school = await readJson<Record<string, unknown>>("school.json");
  return {
    schemaVersion: 1,
    school,
    users: [],
    children: [],
    teachers: [],
    notifications: [],
    complaints: [],
    leaveRequests: [],
    linkRequests: [],
    devices: [],
    files: [],
    helpTopics: [],
    termsSections: [],
    privacySections: [],
    idempotency: []
  };
}

export async function createDemoStore(config: AppConfig): Promise<Store> {
  const source = await readJson<Record<string, any>>("mock-data.json");
  const teachers = await readJson<Array<Record<string, any>>>("teachers.json");
  const school = await readJson<Record<string, unknown>>("school.json");
  const children = source.children as Array<Record<string, any>>;
  const files: FileRecord[] = [];
  attachFileKeys(children, files);
  const now = new Date().toISOString();
  const guardian = source.guardian as Record<string, any>;
  const guardianHash = await bcrypt.hash(config.demoGuardianPassword, 12);
  const teacherHash = await bcrypt.hash(config.demoTeacherPassword, 12);
  const adminHash = await bcrypt.hash(config.demoAdminPassword, 12);

  const users: User[] = [{
    id: String(guardian.id),
    role: "guardian",
    fullName: String(guardian.fullName),
    email: String(guardian.email).toLowerCase(),
    mobileNumber: String(guardian.mobileNumber ?? ""),
    address: guardian.address ?? null,
    profilePhotoUrl: guardian.profilePhotoUrl ?? null,
    relationship: guardian.relationship ?? "Parent",
    profileComplete: Boolean(guardian.profileComplete),
    language: "en",
    passwordHash: guardianHash,
    tokenVersion: 0,
    isActive: true,
    childIds: children.map((child) => String(child.id)),
    createdAt: now,
    updatedAt: now
  }];

  for (const teacher of teachers) {
    const email = String(teacher.email ?? `${safePart(String(teacher.id))}@greenwood-demo.edu`).toLowerCase();
    if (users.some((user) => user.email === email)) continue;
    users.push({
      id: `user_${String(teacher.id)}`,
      role: "teacher",
      fullName: String(teacher.name),
      email,
      mobileNumber: String(teacher.phone ?? ""),
      profilePhotoUrl: teacher.photoUrl ?? null,
      language: "en",
      passwordHash: teacherHash,
      tokenVersion: 0,
      isActive: true,
      teacherId: String(teacher.id),
      classes: Array.isArray(teacher.classes) ? teacher.classes.map(String) : [],
      createdAt: now,
      updatedAt: now
    });
  }

  users.push({
    id: "user_school_admin",
    role: "admin",
    fullName: "School Administrator",
    email: "admin@greenwood-demo.edu",
    mobileNumber: "",
    language: "en",
    passwordHash: adminHash,
    tokenVersion: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now
  });

  const notifications = (source.notifications as Array<Record<string, any>>).map((item) => ({
    id: String(item.id ?? makeId("ntf")),
    userId: String(guardian.id),
    title: String(item.title ?? "School notification"),
    message: String(item.message ?? ""),
    titleEn: String(item.title ?? "School notification"),
    messageEn: String(item.message ?? ""),
    titleHi: String(item.title ?? "School notification"),
    messageHi: String(item.message ?? ""),
    type: String(item.type ?? "announcement"),
    audienceType: "seeded",
    ...(item.childId ? { entityId: String(item.childId) } : {}),
    read: Boolean(item.read),
    createdAt: timestamp(item.createdAt),
    pushStatus: "no_devices" as const
  }));

  const complaints = (source.complaints as Array<Record<string, any>>).map((item) => ({
    id: String(item.id ?? makeId("cmp")),
    guardianId: String(guardian.id),
    childId: String(item.childId ?? children[0]?.id ?? ""),
    subject: String(item.subject ?? "Complaint"),
    message: String(item.message ?? ""),
    ...(item.category ? { category: String(item.category) } : {}),
    ...(item.attachmentKey ? { attachmentKey: String(item.attachmentKey) } : {}),
    status: String(item.status ?? "Submitted"),
    createdAt: timestamp(item.createdAt)
  }));
  const leaveRequests = (source.leaveRequests as Array<Record<string, any>>).map((item) => ({
    id: String(item.id ?? makeId("leave")),
    guardianId: String(guardian.id),
    childId: String(item.childId ?? children[0]?.id ?? ""),
    startDate: String(item.startDate ?? ""),
    endDate: String(item.endDate ?? ""),
    reason: String(item.reason ?? ""),
    status: String(item.status ?? "Pending"),
    createdAt: timestamp(item.createdAt)
  }));
  const linkRequests = (source.linkRequests as Array<Record<string, any>>).map((item) => ({
    id: String(item.id ?? makeId("link")),
    guardianId: String(guardian.id),
    studentId: String(item.studentId ?? ""),
    studentName: String(item.studentName ?? ""),
    status: String(item.status ?? "Pending"),
    createdAt: timestamp(item.createdAt)
  }));

  return {
    schemaVersion: 1,
    school,
    users,
    children,
    teachers,
    notifications,
    complaints,
    leaveRequests,
    linkRequests,
    devices: [],
    files,
    helpTopics: Array.isArray(source.helpTopics) ? source.helpTopics : [],
    termsSections: Array.isArray(source.termsSections) ? source.termsSections : [],
    privacySections: Array.isArray(source.privacySections) ? source.privacySections : [],
    idempotency: []
  };
}
