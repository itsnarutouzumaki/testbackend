import type { Store, User } from "../types";

function canSeeChild(user: User, child: Record<string, any>, store: Store): boolean {
  if (user.role === "admin") return true;
  if (user.role === "guardian") return Boolean(user.childIds?.includes(String(child.id)));
  const teacher = store.teachers.find((item) => String(item.id) === String(user.teacherId));
  const assignedClasses = user.classes ?? (Array.isArray(teacher?.classes) ? teacher.classes.map(String) : []);
  return assignedClasses.includes(String(child.className)) || (child.academicYears ?? []).some((year: Record<string, any>) => assignedClasses.includes(String(year.className)));
}

export function buildAppData(store: Store, user: User) {
  const children = store.children.filter((child) => canSeeChild(user, child, store));
  const visibleChildIds = new Set(children.map((child) => String(child.id)));
  const visibleFiles = store.files.filter((file) => user.role === "admin" || visibleChildIds.has(file.childId));
  const profile = {
    id: user.id,
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    mobileNumber: user.mobileNumber ?? "",
    ...(user.address !== undefined ? { address: user.address } : {}),
    profilePhotoUrl: user.profilePhotoUrl ?? null,
    relationship: user.relationship ?? null,
    profileComplete: user.profileComplete ?? false,
    language: user.language
  };

  const isAdmin = user.role === "admin";
  const ownNotifications = store.notifications
    .filter((item) => item.userId === user.id)
    .map((item) => {
      const created = new Date(item.createdAt);
      const now = new Date();
      const sameDay = created.toDateString() === now.toDateString();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const isYesterday = created.toDateString() === yesterday.toDateString();
      const locale = user.language === "hi" ? "hi-IN" : "en-IN";
      const time = created.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
      const dateLabel = sameDay ? `${user.language === "hi" ? "आज" : "Today"} · ${time}`
        : isYesterday ? `${user.language === "hi" ? "कल" : "Yesterday"} · ${time}`
        : created.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
      return {
        id: item.id,
        title: user.language === "hi" ? item.titleHi : item.titleEn,
        message: user.language === "hi" ? item.messageHi : item.messageEn,
        type: item.type,
        ...(item.entityId ? { entityId: item.entityId } : {}),
        read: item.read,
        createdAt: item.createdAt,
        dateLabel
      };
    });
  const ownComplaints = store.complaints.filter((item) => item.guardianId === user.id || visibleChildIds.has(item.childId) && isAdmin);
  const ownLeaveRequests = store.leaveRequests.filter((item) => item.guardianId === user.id || visibleChildIds.has(item.childId) && isAdmin);
  const ownLinkRequests = store.linkRequests.filter((item) => item.guardianId === user.id || isAdmin);

  return {
    dataVersion: store.schemaVersion,
    generatedAt: new Date().toISOString(),
    school: store.school,
    guardian: profile,
    children,
    teachers: store.teachers,
    notifications: ownNotifications,
    complaints: ownComplaints,
    leaveRequests: ownLeaveRequests,
    linkRequests: ownLinkRequests,
    helpTopics: store.helpTopics,
    termsSections: store.termsSections,
    privacySections: store.privacySections,
    files: visibleFiles.map(({ key, childId, kind, title, filename, contentType, recordId, academicYear }) => ({
      key, childId, kind, title, filename, contentType, recordId, ...(academicYear ? { academicYear } : {})
    }))
  };
}
