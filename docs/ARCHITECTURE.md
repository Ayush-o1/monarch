# Architecture

## 1. Technology Choices and Trade-offs

| Decision                                    | Alternative       | Trade-off                                                                                           |
| ------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| Sessions in Postgres                        | JWT               | Needs a table and a store, but logout and revocation are simple. A different story from BlackWater. |
| Raw SQL                                     | ORM               | More typing, but you see every query, transaction and lock.                                         |
| DB triggers for locking                     | App checks only   | Extra SQL to maintain, but the rules hold even if app code has a bug.                               |
| Landlord token link                         | Landlord accounts | Link can be forwarded. Mitigated with hashing, expiry and revocation.                               |
| Money as integer paise                      | Decimal or float  | Requires conversion at the UI edge. No rounding errors.                                             |
| Local-disk storage behind a small interface | Direct S3         | Not durable on free hosts. Interface lets deployment swap it.                                       |
| `node:test`                                 | Jest              | Fewer features, zero extra dependency.                                                              |
| Vanilla multi-page                          | SPA               | More page loads. Matches the skills I want to strengthen.                                           |

## 2. Directory Structure

```
monarch/
  src/
    app.js                  # builds the Express app (no listen); used by tests
    server.js               # reads config, listens
    config.js               # parses env, fails fast on bad values
    db/
      pool.js               # pg Pool; parse bigint as JS number (values stay below 2^53)
      migrate.js            # migration runner
      migrations/           # 001_*.sql ...
    middleware/
      requireUser.js        # session check
      landlordToken.js      # token lookup: 404 invalid, 410 expired/revoked
      originCheck.js        # CSRF defence for non-GET cookie requests
      rateLimits.js
      validate.js           # zod helper
      errorHandler.js       # one JSON error shape
    lib/
      errors.js             # AppError(status, code, message, details)
      money.js              # paise formatting helpers
      tokens.js             # generate + hash invite tokens
      comparison.js         # pure comparison logic
      events.js             # recordEvent(client, ...)
      storage/local.js      # save/read/delete files by server-made key
    modules/                # each: routes.js, service.js, schemas.js
      auth/ tenancies/ invites/ inspections/ items/ media/
      landlord/ deductions/ settlement/ report/
  public/
    css/styles.css
    js/ api.js ui.js money.js pages/*.js
    *.html
  scripts/seed-demo.js
  tests/ unit/ integration/ helpers/
  docs/ PLAN.md ARCHITECTURE.md TESTING.md
  uploads/                  # gitignored
```

## 3. Data Model

- All IDs are UUID (`gen_random_uuid()`), except `events.id` which is a bigint identity.
- Timestamps are `timestamptz`.
- Money is integer paise (`bigint`). Maximum deposit is 1,000,000,000 paise (Rs 1 crore).

### Tables

1. **users**: `id`, `name (1..80, trimmed)`, `email (3..255)`, `password_hash`, `created_at`. Unique index on `lower(email)`. Check constraints on name and email length (`users_name_length_check`, `users_email_length_check`).
2. **session**: `sid varchar primary key`, `sess json not null`, `expire timestamp(6) not null`, index on `expire`.
3. **tenancies**: `id`, `tenant_id -> users`, `property_label (1..80)`, `address (<=300, null ok)`, `landlord_name (<=80, null ok)`, `deposit_paise (CHECK 1..1_000_000_000)`, `refund_window_days (CHECK 1..365, null ok)`, `lease_start_date (date, null ok)`, `status CHECK in ('active','move_out','settling','closed') default 'active'`, `closed_at null`, `created_at`, `updated_at`. Index on `(tenant_id, created_at desc)`.
4. **inspections**: `id`, `tenancy_id -> tenancies`, `type CHECK in ('move_in','move_out')`, `status CHECK in ('draft','submitted','acknowledged') default 'draft'`, `submitted_at`, `acknowledged_at`, `acknowledged_by_name`, `created_at`. UNIQUE `(tenancy_id, type)`.
   - Trigger `inspections_guard`: `type` and `tenancy_id` immutable. Transitions allowed: draft->submitted, submitted->acknowledged, submitted->draft. `acknowledged` is terminal.
5. **inspection_items**: `id`, `inspection_id -> inspections`, `room (1..80)`, `name (1..80)`, `condition CHECK in ('good','minor_wear','damaged','missing') nullable while draft`, `note (<=1000, null ok)`, `position int`, `created_at`, `updated_at`. Unique index `(inspection_id, lower(room), lower(name))`. Max 300 items per inspection.
   - Trigger `require_draft_inspection`: reads parent inspection `FOR SHARE`; raises `LOCKED:` if status != 'draft'.
6. **media**: `id uuid pk default gen_random_uuid()`, `item_id uuid not null references inspection_items(id) on delete cascade`, `storage_key text not null unique`, `sha256 char(64) not null`, `mime text not null check (mime = 'image/jpeg')`, `size_bytes integer not null check (size_bytes > 0)`, `uploaded_at timestamptz not null default now()`. `UNIQUE (item_id, sha256)`. Index on `item_id`. Max 8 photos per item.
   - Trigger `require_draft_media`: reads parent item's inspection `FOR SHARE`; raises `LOCKED:` if status != 'draft'; `item_id` is immutable; allows foreign-key cascade when parent item is deleted in draft status.
7. **invites**: `id`, `tenancy_id`, `token_hash (sha256 hex, unique)`, `expires_at`, `revoked_at null`, `last_used_at null`, `created_at`. Partial unique index on `(tenancy_id) WHERE revoked_at IS NULL`.
8. **deduction_lines**: `id`, `tenancy_id`, `item_id -> inspection_items` (nullable; must belong to move-out inspection), `description (1..300)`, `amount_paise (CHECK > 0)`, `status CHECK in ('proposed','accepted','disputed','withdrawn') default 'proposed'`, `tenant_note (<=500, null ok)`, `created_by_name`, `created_at`, `responded_at`, `updated_at`. Index on `(tenancy_id)`.
9. **events (append-only)**: `id bigint identity`, `tenancy_id -> tenancies` (no cascade), `actor_type CHECK in ('tenant','landlord','system')`, `actor_label`, `type`, `payload jsonb default '{}'`, `created_at`.
   - Triggers: UPDATE, DELETE, and TRUNCATE raise an exception. Index on `(tenancy_id, id)`.

## 4. Business Rules

### Tenancy Lifecycle

- States: `active` -> `move_out` -> `settling` -> `closed`.
- Creating tenancy creates move-in draft inspection atomically.
- Starting move-out requires tenancy `active` and move-in inspection `submitted` or `acknowledged`. Copies items with blank condition and note; sets tenancy to `move_out`. Concurrency locked via tenancy row.
- Submitting move-out sets tenancy to `settling`.

### Inspection Submission

- Requires status `draft`, >= 1 item, and all items to have a condition assigned.

### Media Upload Pipeline

- **Authorisation Pre-check**: Before running Sharp image decoding, the server verifies that the parent item exists, belongs to the session tenant, and is part of an inspection in `draft` status (refuses with 404 or 409 fast).
- **Sharp Processing**: Limits input pixels to 40,000,000 to prevent decompression bomb attacks; allows only JPEG, PNG, and WebP input (415 UNSUPPORTED_MEDIA); applies auto-rotation from EXIF orientation; resizes down to fit inside 1600x1600 without enlargement; encodes to JPEG quality 80. Metadata is intentionally not preserved, which strips sensitive EXIF data including camera details and GPS coordinates.
- **Deduplication & Storage Coordination**: Generates sha256 of processed bytes. The file is written to local storage first under `${tenancyId}/${randomUUID()}.jpg`. Then, inside a database transaction with a row lock (`FOR UPDATE`) on the item, the photo count is verified (< 8) and inserted. If insertion fails (e.g. duplicate photo on `item_id, sha256`), the file is immediately removed.
- **Cascade File Removal**: When an item is deleted, storage keys of associated media rows are selected before deletion; upon transaction commit, files are removed from disk.

### Landlord Actions (Token Link)

- Move-in: acknowledge, or request changes with note (returns to `draft`, allowed only while tenancy is `active`).
- Move-out: acknowledge only. Disagreements handled via deduction lines.
- Concurrency handled by conditional update (`WHERE status='submitted'`).

### Comparison Engine

- Pure function in `lib/comparison.js`.
- Key: `lower(trim(room))|lower(trim(name))`.
- Condition ranks: good (3) > minor_wear (2) > damaged (1) > missing (0).
- Outcomes: `worse`, `same`, `better`, `new_at_move_out`, `not_in_move_out`.

### Deductions and Settlement

- Propose allowed only while tenancy is `settling`.
- Total proposed + accepted + disputed cannot exceed `deposit_paise`.
- Status transitions:
  - Tenant: proposed -> accepted, proposed -> disputed, disputed -> accepted.
  - Landlord: proposed -> withdrawn, disputed -> withdrawn.
  - Accepted is final.
- Close: Allowed in `settling`. If unresolved lines exist, tenant must confirm `acknowledgeUnresolved: true`. Closes tenancy; rejects future deduction changes.

## 5. API Contract Summary

All errors follow:

```json
{
  "error": {
    "code": "CODE_NAME",
    "message": "Human readable message",
    "details": {}
  }
}
```

### Tenant Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/health`
- `POST /api/tenancies`
- `GET /api/tenancies`
- `GET /api/tenancies/:id`
- `GET /api/tenancies/:id/events`
- `POST /api/tenancies/:id/invite`
- `DELETE /api/tenancies/:id/invite`
- `POST /api/tenancies/:id/move-out`
- `GET /api/tenancies/:id/comparison`
- `GET /api/tenancies/:id/settlement`
- `POST /api/tenancies/:id/close`
- `GET /api/tenancies/:id/report.pdf`
- `GET /api/inspections/:id`
- `POST /api/inspections/:id/submit`
- `POST /api/inspections/:id/items`
- `PATCH /api/items/:id`
- `DELETE /api/items/:id`
- `POST /api/items/:id/media`
- `GET /api/media/:id`
- `DELETE /api/media/:id`
- `PATCH /api/deductions/:id`

### Landlord Endpoints

- `GET /l/:token` -> serves `landlord.html`
- `GET /api/landlord/:token/tenancy`
- `GET /api/landlord/:token/media/:mediaId`
- `POST /api/landlord/:token/inspections/:id/acknowledge`
- `POST /api/landlord/:token/inspections/:id/request-changes`
- `POST /api/landlord/:token/deductions`
- `POST /api/landlord/:token/deductions/:id/withdraw`

## 6. Security and Known Trade-offs

- **Session Authentication**: Server-side sessions stored in PostgreSQL via `connect-pg-simple`, utilizing httpOnly, sameSite=lax cookies with 7-day expiration.
- **CSRF Defense**: `originCheck` middleware verifies request `Origin` / `Referer` against the `Host` header on all state-changing API requests.
- **Password Hashing**: Cost 12 bcryptjs. Enforces minimum 10 characters and maximum 72 bytes (the bcrypt truncation boundary). Login timing side-channel mitigation performs a dummy bcrypt compare when an email is not found.
- **Accepted Trade-off**: Registration reveals whether an email already exists (returns 409 `EMAIL_TAKEN`), allowing an attacker to determine if an email is registered. This is an accepted trade-off to provide immediate feedback to the tenant during registration.
- **Media Privacy & Authenticated Serving**: All EXIF and GPS geolocation metadata are stripped during Sharp image re-encoding. Media files are stored using server-generated keys and never served directly as public static assets; access is strictly mediated through authenticated routes (`GET /api/media/:id`), ensuring complete tenant tenancy isolation and IDOR prevention.
- **Known Limitations (HEIC Format)**: True HEIC/HEIF files are not accepted by the backend. Modern mobile browsers (such as Safari on iOS) automatically transcode HEIC photos to standard JPEG when selecting files through an `<input type="file" accept="image/*">` element.
- **Known Limits (Trigger Security)**: The table owner (the app role in development) can disable triggers, so the append-only and lock triggers stop mistakes and application bugs, not a privileged database attacker; Phase 10 will separate migration (DDL) and app runtime (DML) roles.
