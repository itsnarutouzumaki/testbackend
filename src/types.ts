export type UserRole = "guardian" | "teacher" | "admin";
export type Language = "en" | "hi";
export type LocalizedText = string | { en?: string; hi?: string };

export interface User {
  id: string;
  role: UserRole;
  fullName: string;
  email: string;
  mobileNumber?: string;
  address?: string | null;
  profilePhotoUrl?: string | null;
  relationship?: string;
  profileComplete?: boolean;
  language: Language;
  passwordHash: string;
  tokenVersion: number;
  isActive: boolean;
  childIds?: string[];
  teacherId?: string;
  classes?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRegistration {
  id: string;
  userId: string;
  expoPushToken: string;
  platform: "ios" | "android" | "unknown";
  deviceId?: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  message: string;
  titleEn: string;
  messageEn: string;
  titleHi: string;
  messageHi: string;
  type: string;
  audienceType: string;
  entityId?: string;
  read: boolean;
  createdAt: string;
  pushStatus: "not_attempted" | "accepted" | "no_devices" | "failed";
}

export interface ComplaintRecord {
  id: string;
  guardianId: string;
  childId: string;
  subject: string;
  message: string;
  category?: string;
  attachmentKey?: string | null;
  attachmentName?: string;
  status: string;
  createdAt: string;
}

export interface LeaveRequestRecord {
  id: string;
  guardianId: string;
  childId: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: string;
  createdAt: string;
}

export interface LinkRequestRecord {
  id: string;
  guardianId: string;
  studentId: string;
  studentName: string;
  status: string;
  createdAt: string;
}

export interface FileRecord {
  key: string;
  childId: string;
  kind: "fee_receipt" | "test_copy" | "other";
  title: string;
  filename: string;
  contentType: string;
  storageName: string;
  recordId: string;
  academicYear?: string;
  demoFixture: boolean;
}

export interface IdempotencyRecord {
  key: string;
  userId: string;
  route: string;
  resourceId: string;
  createdAt: string;
}

export interface Store {
  schemaVersion: number;
  school: Record<string, unknown>;
  users: User[];
  children: Array<Record<string, any>>;
  teachers: Array<Record<string, any>>;
  notifications: NotificationRecord[];
  complaints: ComplaintRecord[];
  leaveRequests: LeaveRequestRecord[];
  linkRequests: LinkRequestRecord[];
  devices: DeviceRegistration[];
  files: FileRecord[];
  helpTopics: unknown[];
  termsSections: unknown[];
  privacySections: unknown[];
  idempotency: IdempotencyRecord[];
}

export interface AuthenticatedRequestUser {
  id: string;
  role: UserRole;
  tokenVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedRequestUser;
    }
  }
}
