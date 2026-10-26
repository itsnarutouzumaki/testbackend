import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { AppConfig } from "./config";
import type { JsonStoreRepository } from "./repositories/json-store";
import { authRoutes } from "./routes/auth.routes";
import { appDataRoutes } from "./routes/app-data.routes";
import { complaintsRoutes } from "./routes/complaints.routes";
import { leaveRequestRoutes } from "./routes/leave-requests.routes";
import { profileRoutes } from "./routes/profile.routes";
import { filesRoutes } from "./routes/files.routes";
import { notificationRoutes, type PushSender } from "./routes/notifications.routes";
import { childrenRoutes } from "./routes/children.routes";
import { adminRoutes } from "./routes/admin.routes";
import { debugRoutes } from "./routes/debug.routes";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { httpLoggingMiddleware } from "./middleware/http-logging";

export interface CreateAppOptions {
  config: AppConfig;
  repository: JsonStoreRepository;
  pushSender?: PushSender;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || options.config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not permitted by CORS."));
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"]
  }));
  app.use(express.json({ limit: "2mb", strict: true }));
  app.use(httpLoggingMiddleware(options.config.httpDebugLogging));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));

  app.get("/health", (_req, res) => res.status(200).json({ success: true, message: "Guardian School API is healthy." }));
  app.use("/api/v1/auth", authRoutes(options));
  app.use("/api/v1/app-data", appDataRoutes(options));
  app.use("/api/v1/complaints", complaintsRoutes(options));
  app.use("/api/v1/leave-requests", leaveRequestRoutes(options));
  app.use("/api/v1/profile", profileRoutes(options));
  app.use("/api/v1/files", filesRoutes(options));
  app.use("/api/v1/notifications", notificationRoutes(options));
  app.use("/api/v1/children", childrenRoutes(options));
  app.use("/api/v1/admin", adminRoutes(options));
  app.use("/api/v1/debug", debugRoutes({ ...options, ...(options.pushSender ? { pushSender: options.pushSender } : {}) }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
