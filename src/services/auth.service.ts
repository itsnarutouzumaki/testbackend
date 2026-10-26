import bcrypt from "bcryptjs";
import type { User } from "../types";
import { AppError } from "../errors";
import { normalizeEmail, normalizePhone } from "../utils/ids";

export function publicUser(user: User) {
  return {
    id: user.id,
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    ...(user.mobileNumber ? { mobileNumber: user.mobileNumber } : {}),
    ...(user.address !== undefined ? { address: user.address } : {}),
    ...(user.profilePhotoUrl !== undefined ? { profilePhotoUrl: user.profilePhotoUrl } : {}),
    ...(user.relationship ? { relationship: user.relationship } : {}),
    ...(user.profileComplete !== undefined ? { profileComplete: user.profileComplete } : {}),
    language: user.language
  };
}

export async function verifyPassword(user: User | undefined, password: string): Promise<boolean> {
  if (!user) {
    // Keep login behavior similar for known/unknown email to reduce account enumeration timing.
    await bcrypt.compare(password, "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy");
    return false;
  }
  return bcrypt.compare(password, user.passwordHash);
}

export function assertGuardianChildAccess(user: User, childId: string) {
  if (user.role === "admin") return;
  if (user.role !== "guardian" || !user.childIds?.includes(childId)) {
    throw new AppError(404, "The requested student could not be found.", "STUDENT_NOT_FOUND");
  }
}

export function sameEmail(a: string, b: string) {
  return normalizeEmail(a) === normalizeEmail(b);
}

export function samePhone(a: string, b: string) {
  return normalizePhone(a) === normalizePhone(b);
}
