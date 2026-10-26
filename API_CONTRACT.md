# Guardian School API contract — review version 1

Base path: `/api/v1`. Unless noted, responses use JSON. Protected routes send `Authorization: Bearer <accessToken>`.

## Contracts

| Method | Path | Purpose | Write response |
|---|---|---|---|
| POST | `/auth/signup` | Create guardian account | `201`, message + access token + public user needed for session |
| POST | `/auth/login` | Login by email/mobile + password | `200`, access token + public user |
| POST | `/auth/change-password` | Verify current password and change it | Message only; prior tokens invalidated |
| GET | `/app-data` | Full authorized app snapshot | Data snapshot (the intentional large read) |
| POST | `/complaints` | Submit complaint with optional multipart attachment | `201`, message only |
| POST | `/leave-requests` | Submit leave data plus same app password | `201`, message only |
| POST | `/profile/update` | Update guardian name/photo | Message only |
| POST | `/profile/language` | Save `en` or `hi` for notification localization | Message only |
| POST | `/files/download?key=<uniqueKey>` | Download authorized file | Binary file body |
| POST | `/notifications/register-device` | Register Expo token | Message only |
| POST | `/notifications/unregister-device` | Deactivate current account's device token | Message only |
| POST | `/notifications/read` | Mark one notification read | Message only |
| POST | `/notifications/read-all` | Mark current user's notifications read | Message only |
| POST | `/notifications/send` | Send one announcement request to a group | `202`, status/message only |
| POST | `/children/link-requests` | Ask school to link a child | Message only |
| POST | `/children/link-requests/:requestId/decision` | Admin approves/rejects a link request | Message only |

## Read snapshot

`GET /app-data` returns `dataVersion`, `generatedAt`, `school`, `guardian`, the guardian's linked `children` and all nested academic-year/month details, teacher records, the current user's notifications, complaints, leave/link requests, help content, legal sections and accessible file metadata. File binaries are never embedded in this response. Each receipt/test copy can carry a unique `fileKey`.

`POST /complaints` accepts JSON for text-only complaints or `multipart/form-data` with an optional `attachment` file (PDF/JPG/PNG, maximum 5 MB). Actual file bytes are stored outside the JSON store; the JSON record stores the unique file key and original safe filename.

## Leave request — one request containing page fields and password

```json
{
  "childId": "aarav",
  "startDate": "2026-11-02",
  "endDate": "2026-11-03",
  "reason": "Medical appointment",
  "password": "Demo@123"
}
```

The fields above match the current supplied `LeaveRequestScreen`. If Page 1 gains another field, add and validate that field in the request schema and record model. Do not persist or log `password`. A wrong password returns `401`; invalid dates/reason return `400`; the request is saved only after password and guardian-child authorization checks pass. Optional `Idempotency-Key` protects retries from duplicate creation.

## Group notification

```json
{
  "subject": { "en": "School holiday", "hi": "विद्यालय में अवकाश" },
  "content": { "en": "School is closed tomorrow.", "hi": "कल विद्यालय बंद रहेगा।" },
  "audience": { "type": "class", "className": "Class 5", "section": "A" }
}
```

`subject` and `content` may each be a simple string (same text in either language) or an object with `en` and/or `hi`. Audiences:

- `{ "type": "school" }` — admin only; all active guardians and teachers.
- `{ "type": "all_guardians" }` — admin only.
- `{ "type": "all_teachers" }` — admin only.
- `{ "type": "class", "className": "Class 5" }` — guardians with children in that class; an assigned teacher can send to their own classes, admin can select any.
- `{ "type": "class", "className": "Class 5", "section": "A" }` — section-specific guardians.
- `{ "type": "guardian_ids", "ids": ["guardian-demo-001"] }` — admin only.
- `{ "type": "teacher_ids", "ids": ["user_t-priya"] }` — admin only.

One API request is fanned out server-side to all matched active recipient device tokens. The backend creates separate per-user history rows so unread state can be tracked. It chooses the title/body using the user's saved language. A teacher cannot send school-wide announcements or select arbitrary recipients.

## Small write responses

Example:

```json
{ "success": true, "message": "Leave request submitted successfully." }
```

Errors use a message and code rather than returning changed records. The status code reflects success/failure. Authentication responses necessarily include a token; file download returns the file; `/app-data` returns the full snapshot.
