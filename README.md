# Guardian School Backend (JSON-backed development implementation)

A Node.js + Express + TypeScript REST API for the Guardian School React Native app. JSON files are behind a repository layer so the storage implementation can later be replaced by a database without rewriting the route handlers.

**This project is a development/testing backend.** The demo data and demo accounts are not for production. JSON storage is single-process development storage: do not run multiple server instances against the same store file. Real school deployment needs a durable database, secure secrets, HTTPS, backups, monitoring and operational access controls.

## Requirements

- Node.js 20 or newer
- npm
- A physical Android device and an Expo development/release build for real push tests

## Run locally (Windows PowerShell)

```powershell
cd guardian-school-backend
npm install
Copy-Item .env.example .env
```

Edit `.env` and set a private `JWT_SECRET` with at least 32 random characters. For local testing, keep `ENABLE_DEMO_DATA=true`. Then run:

```powershell
npm run seed:demo
npm run dev
```

The API listens on `http://localhost:4000` and binds to all interfaces for phone testing. Check `http://localhost:4000/health`.

The demo seeding command **overwrites `data/store.json`**, including changes made while testing. Back up this file before reseeding.

### Demo accounts (development only)

| Role | Login | Default password |
|---|---|---|
| Guardian | `priya.sharma@example.com` | `Demo@123` |
| Teacher | use the seeded teacher email in `data/seed/teachers.json` (for example `priya.sharma@greenwood-demo.edu`, if present) | `DemoTeacher@123` |
| School admin | `admin@greenwood-demo.edu` | `DemoAdmin@123` |

Passwords can be changed in `.env` before running `npm run seed:demo`. Stored passwords are bcrypt hashes; demo passwords are not stored in `data/store.json`.

Do not use demo accounts, demo data or default credentials in production. In production set `NODE_ENV=production`, `ENABLE_DEMO_DATA=false`, a strong `JWT_SECRET`, configured CORS origins, persistent storage and a real account provisioning flow. If the production store is missing, startup initializes an empty store rather than seeding demo students.

## Connect a physical phone

`localhost` on the phone is the phone itself. Find the PC's LAN IPv4 address (for example `192.168.1.25`), allow incoming TCP port 4000 in Windows Firewall for your private network, and set the app's development API base URL to:

```text
http://192.168.1.25:4000/api/v1
```

The phone and computer must be able to reach each other on the same network. For production use a public HTTPS backend URL; do not expose this development server to the public internet.

## API conventions

Base URL: `/api/v1`

Successful writes return only a small `{ "success": true, "message": "..." }` response (HTTP status code carries the operation result). They do not return the updated complaint, profile, leave-request or notification record. Authentication endpoints return the access token because the app needs it. File download returns binary file content. `GET /app-data` is the initial, complete authorized snapshot and returns a potentially large response.

Protected routes use:

```http
Authorization: Bearer <accessToken>
```

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | No | Health check (not under `/api/v1`) |
| POST | `/api/v1/auth/signup` | No | Guardian signup; returns access token |
| POST | `/api/v1/auth/login` | No | Login with email or mobile and password |
| POST | `/api/v1/auth/change-password` | Yes | Verify current password and update the password |
| GET | `/api/v1/app-data` | Yes | Full authorized snapshot: guardian, child data, monthly attendance/fees, tests/results, teachers, history, notifications and file metadata |
| POST | `/api/v1/complaints` | Guardian | Submit a complaint |
| POST | `/api/v1/leave-requests` | Guardian | Submit leave request; password is sent in the same HTTPS request and verified server-side |
| POST | `/api/v1/profile/update` | Yes | Update editable profile fields (name/photo) |
| POST | `/api/v1/profile/language` | Yes | Persist `en` or `hi` language preference for notification localization |
| POST | `/api/v1/files/download?key=<fileKey>` | Yes | Download a file after per-child authorization |
| POST | `/api/v1/notifications/register-device` | Yes | Register an Expo push token and platform |
| POST | `/api/v1/notifications/unregister-device` | Yes | Deactivate a device token for the current account/logout |
| POST | `/api/v1/notifications/read` | Yes | Mark one notification read |
| POST | `/api/v1/notifications/read-all` | Yes | Mark all notifications for the current user read |
| POST | `/api/v1/notifications/send` | Admin/teacher with audience restrictions | Create notification-history records and attempt Expo push delivery |
| POST | `/api/v1/children/link-requests` | Guardian | Ask the school to link a child by student/admission ID |
| POST | `/api/v1/children/link-requests/:requestId/decision` | Admin | Approve/reject a pending child link request |
| GET | `/api/v1/admin/debug/store-snapshot` | Admin (temporarily enabled) | Export a bounded, credential-redacted JSON store snapshot |
| GET | `/api/v1/debug/store-snapshot` | No (test only) | Browser snapshot, only when enabled outside production |
| GET | `/api/v1/debug/send-test-notification?to=<guardianId>` | No (test only) | **Triggers a test push** to a registered demo guardian |

### 1. Login

`POST /api/v1/auth/login`

```json
{
  "identifier": "priya.sharma@example.com",
  "password": "Demo@123"
}
```

The response includes `accessToken`, `tokenType`, and a safe user profile. Never expose or return `passwordHash`.

### 2. Get all app data

`GET /api/v1/app-data`

Requires a Bearer token. Returns the complete data snapshot scoped to the authenticated account. Guardians receive only their linked children, related complaints/leave requests, notifications and files. Teacher visibility is restricted to assigned classes for child records/files. Password hashes, device tokens and internal auth information are never returned. The data currently comes from the app's supplied mock dataset, with development-only demo accounts.

The app should avoid separate read calls for each screen by using this snapshot. This does **not** mean the snapshot remains permanently current: school data can change, so the app needs an explicit refresh strategy later.

### 3. Complaint

`POST /api/v1/complaints`

JSON without an attachment:

```json
{
  "childId": "aarav",
  "category": "transport",
  "subject": "Bus timing issue",
  "message": "The bus arrived late today."
}
```

The same endpoint also accepts `multipart/form-data` with the same text fields and an optional file field named `attachment` (PDF/JPG/PNG, up to 5 MB). The backend checks the file signature, stores the binary in the configured file directory, registers a unique file key and links that key to the complaint. The attachment can later be downloaded through the shared file endpoint. Do not send a device-local URI as if it were a server file.

Only guardians linked to the child may submit. The response contains a success flag and message only; the complaint is written to `data/store.json` and appears in the next `/app-data` response.

### 4. Leave request (form plus password together)

`POST /api/v1/leave-requests`

```json
{
  "childId": "aarav",
  "startDate": "2026-11-02",
  "endDate": "2026-11-03",
  "reason": "Medical appointment",
  "password": "Demo@123"
}
```

`reason` is mandatory and whitespace-only values are rejected. The backend verifies the supplied password against the authenticated guardian's stored bcrypt hash, validates the guardian-child relationship, and then creates the request. The password is never persisted or logged. An optional `Idempotency-Key` header helps avoid duplicate requests on retries; the same key is scoped to the user and endpoint.

Example response:

```json
{ "success": true, "message": "Leave request submitted successfully." }
```

### 5. File downloads

`POST /api/v1/files/download?key=fr_aarav_2026_27_fee_0`

Use a key from `/app-data` and the normal Bearer token. The response is a PDF stream with `Content-Disposition: attachment`. The key is looked up in a file catalogue; the client cannot pass a filesystem path. Guardian/teacher access to the associated child is checked.

**Important demo limitation:** no real school receipts or teacher-uploaded test copies were included in the frontend archive. Seeded file keys currently map to clearly labelled demo PDF fixtures so the download route can be tested. Replace these fixture mappings with real server-managed files before production. Do not represent these PDFs as actual financial receipts or exam copies.

### 6. Device token registration

`POST /api/v1/notifications/register-device`

```json
{
  "expoPushToken": "ExpoPushToken[replace-with-a-real-token]",
  "platform": "android",
  "deviceId": "optional-device-install-id"
}
```

Register the real token obtained from a supported Expo development/production build after permission is granted. Do not paste a fake token expecting it to receive a notification. Logging out or changing account on a device should later deactivate/unregister that token as part of app integration.

### 7. Send notification to groups (Postman)

`POST /api/v1/notifications/send`

Requires a Bearer token for an admin or teacher. Requests must include title/subject, message/content and audience selection. `subject` and `content` can each be a simple string (same content for both languages) or a bilingual object so recipients receive the selected language.

School-wide announcement:

```json
{
  "subject": { "en": "School holiday", "hi": "विद्यालय में अवकाश" },
  "content": { "en": "School is closed tomorrow.", "hi": "कल विद्यालय बंद रहेगा।" },
  "audience": { "type": "school" }
}
```

All guardians:

```json
{
  "subject": { "en": "Fee reminder", "hi": "फीस की याद दिलाना" },
  "content": { "en": "Please check the latest fee status.", "hi": "कृपया फीस की स्थिति देखें।" },
  "audience": { "type": "all_guardians" }
}
```

All guardians of Class 5, Section A:

```json
{
  "subject": { "en": "Class announcement", "hi": "कक्षा की सूचना" },
  "content": { "en": "There is an update for Class 5-A.", "hi": "कक्षा 5-A के लिए एक सूचना है।" },
  "audience": { "type": "class", "className": "Class 5", "section": "A" }
}
```

Other supported audiences:

- `{ "type": "all_teachers" }` — admin only.
- `{ "type": "guardian_ids", "ids": ["guardian-demo-001"] }` — admin only.
- `{ "type": "teacher_ids", "ids": ["user_t-priya"] }` — admin only.
- `{ "type": "class", "className": "Class 5" }` — class across sections, if authorized.

Admin can send school-wide/all-user, all-guardian, all-teacher, class and selected-recipient announcements. A teacher may send to a class listed in that teacher's assigned classes; a teacher cannot send a school-wide announcement or select arbitrary guardians. `school` includes guardians and teachers but not admin accounts. A class notification is fanned out to guardians who have children in the selected class/section.

Every matched recipient gets an unread notification-history item in JSON storage. The backend selects English/Hindi text using the recipient's saved language and attempts push delivery to each active device token. Push uses the default sound and the `school-updates` Android channel. The response reports the result through a concise status/message. Expo ticket acceptance means the push provider accepted the request; it is not proof the device displayed it. Push receipts and `DeviceNotRegistered` errors are not a substitute for actual-device testing.

### HTTP response behavior

- `200` read/update success
- `201` newly created record
- `202` notification queued/dispatch attempted
- `400` invalid input
- `401` missing/invalid session, invalid login credentials, or wrong leave password
- `403` authenticated account lacks permission
- `404` record/file unavailable or outside authorized scope
- `409` duplicate email/mobile or conflicting request
- `429` rate limit
- `500` unexpected server error

Errors use `{ "success": false, "message": "...", "code": "..." }`. Write responses intentionally do not return the updated record.

## JSON storage design

`JsonStoreRepository` serializes mutations in one Node process and uses a temporary file + atomic rename. Feature code does not directly edit `data/store.json`; it calls the repository. This keeps a future database replacement isolated to repository/service code.

This does not provide multi-process locking, high availability, transactional guarantees across multiple servers, or database-level query performance. For production, migrate to a real database before scaling and keep file binaries in durable object storage or protected disk storage.

## Temporary Render debugging

Request logging is concise by default and includes a request ID, method, path, response status and duration. For a temporary debugging session, set `HTTP_DEBUG_LOGGING=true` in the Render service environment and redeploy/restart. Detailed logs include sanitized JSON query parameters and bodies; credentials and common guardian/student identifying fields are redacted. Binary/file responses are never logged, output is truncated, and store-snapshot response bodies are never written to logs.

For this dummy-data test backend, the browser-friendly `GET /api/v1/debug/store-snapshot` endpoint is available only when `NODE_ENV` is not `production` and `DEBUG_STORE_EXPORT_ENABLED=true`. It returns a bounded JSON snapshot with credentials and file bytes excluded. The existing `/api/v1/admin/debug/store-snapshot` remains separate and still requires administrator authentication.

The browser-only notification test endpoint has a side effect: opening `GET /api/v1/debug/send-test-notification?to=guardian-demo-001` sends one fixed test notification to that active demo guardian's registered Expo push token. It is available only when `NODE_ENV` is not `production` and `DEBUG_PUSH_TEST_ENABLED=true`, accepts only a demo guardian ID, and is rate-limited. Do not open or refresh this URL unless you intend to trigger a push. It does not accept a message, token or push credential from the query string.

The push response reports the Expo HTTP status, whether a push ticket was accepted, and any Expo ticket IDs. Acceptance is not delivery confirmation. To check delivery, wait about 15 minutes, then submit the returned ticket ID(s) to Expo's receipt endpoint `https://exp.host/--/api/v2/push/getReceipts` (POST JSON `{ "ids": ["<ticket-id>"] }` with the same Expo authorization if your project requires it); inspect each receipt's `status` and `details.error`. Keep both debug flags disabled by default and turn them off immediately after testing. These testing endpoints are disabled in production and are not production data-export or notification interfaces.

## Push notifications requirements

- `expo-notifications` must be configured in the mobile app and the app rebuilt with native configuration changes.
- Test on a real development/production build, not Expo Go for remote push on current SDKs.
- Guardian/teacher/admin accounts need actual authorized authentication before tokens can be registered.
- Set `EXPO_PUSH_ACCESS_TOKEN` if the Expo project requires push API authentication.
- Push token registration alone doesn't trigger notifications; use Postman with an admin/assigned-teacher token and a valid audience.
- Users can disable notification sound/permission in device settings.

## Tests and verification

```powershell
npm run verify
```

Tests cover guardian-scoped snapshot, auth, mandatory leave reason/password verification, compact write responses, file authorization/download, group notification audience/localization, teacher audience restrictions and read-state updates.

## Production blockers

Before production, replace demo credentials/data and JSON storage; set strong secrets; deploy behind HTTPS; add account recovery, refresh/revocation strategy as required, full audit logging without secrets, storage backups and restore procedures, push delivery receipt processing, real uploaded school documents, retention policy and operational monitoring. Verify school/student data permissions with the school before deployment.
