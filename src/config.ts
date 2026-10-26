import path from "node:path";

export interface AppConfig {
  nodeEnv: string;
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  storePath: string;
  fileStorageDir: string;
  enableDemoData: boolean;
  demoGuardianPassword: string;
  demoTeacherPassword: string;
  demoAdminPassword: string;
  expoPushAccessToken?: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const defaultSecret = "dev-only-change-this-secret-at-least-32-chars";
  const jwtSecret = process.env.JWT_SECRET ?? (nodeEnv === "production" ? "" : defaultSecret);
  if (nodeEnv === "production" && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters in production.");
  }
  if (nodeEnv !== "production" && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters.");
  }
  const root = process.cwd();
  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 4000),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "8h",
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:8081,http://localhost:19006").split(",").map((s) => s.trim()).filter(Boolean),
    storePath: path.resolve(root, process.env.JSON_STORE_PATH ?? "./data/store.json"),
    fileStorageDir: path.resolve(root, process.env.FILES_STORAGE_DIR ?? "./storage/files"),
    enableDemoData: bool(process.env.ENABLE_DEMO_DATA, nodeEnv !== "production"),
    demoGuardianPassword: process.env.DEMO_GUARDIAN_PASSWORD ?? "Demo@123",
    demoTeacherPassword: process.env.DEMO_TEACHER_PASSWORD ?? "DemoTeacher@123",
    demoAdminPassword: process.env.DEMO_ADMIN_PASSWORD ?? "DemoAdmin@123",
    expoPushAccessToken: process.env.EXPO_PUSH_ACCESS_TOKEN || undefined
  };
}
