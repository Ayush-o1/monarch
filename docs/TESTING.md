# Testing Guide

## 1. Running Tests

Tests use Node.js built-in test runner (`node:test`) and `supertest`.

- **Run all tests:**

  ```bash
  npm test
  ```

- **Run only unit tests:**

  ```bash
  NODE_ENV=test node --env-file=.env --test 'tests/unit/**/*.test.js'
  ```

- **Run only integration tests:**

  ```bash
  NODE_ENV=test node --env-file=.env --test --test-concurrency=1 'tests/integration/**/*.test.js'
  ```

- **Run code quality checks:**
  ```bash
  npm run lint
  npm run format:check
  ```

## 2. Test Database Setup & Reset

The test suite runs against a dedicated test database (`monarch_test`).

1. **Create the database (one-time setup):**

   ```bash
   createdb monarch_test
   ```

2. **Run migrations against test DB:**

   ```bash
   npm run migrate:test
   ```

3. **Reset test database (if clean slate is needed):**
   ```bash
   dropdb --if-exists monarch_test
   createdb monarch_test
   npm run migrate:test
   ```

_Note: Tests isolate themselves by creating unique users with random emails. Do not use TRUNCATE on the `events` table because it is protected by append-only triggers._

## 3. Manual Testing Checklists

### Phase 0 Checklist

- [x] `npm test` passes without errors.
- [x] `npm run lint` and `npm run format:check` pass.
- [x] Run `npm run dev`:
  - `curl -i http://localhost:3000/api/health` returns HTTP 200 `{"status":"ok"}`.
  - `curl -i http://localhost:3000/api/nope` returns HTTP 404 with error JSON.
  - Open `http://localhost:3000` in browser: minimal page loads with product name and legal notice.
- [x] Start server with `SESSION_SECRET=short` to confirm fast failure.

### Phase 4 Checklist (Items & Lock Trigger)

- [x] Item CRUD in draft status: create, patch, delete, get inspection items.
- [x] Unique item constraint: duplicate room and name (case-insensitive) returns 409 DUPLICATE_ITEM.
- [x] Item cap: creating beyond 300 items per inspection returns 422 TOO_MANY_ITEMS.
- [x] Inspection lock trigger: updating, deleting, or inserting items when inspection status is not draft fails with 409 INSPECTION_LOCKED (`LOCKED:...`).
- [x] Item immutability: attempting to change an item's `inspection_id` fails.
- [x] Strict inspections guard: any update on an acknowledged inspection fails.
- [x] Concurrency: draft lock during status transition blocks concurrent item creation until resolution.

### Phase 5 Checklist (Photos & Media)

- [ ] Upload valid JPEG, PNG, and WebP: processed to JPEG <= 1600x1600 quality 80.
- [ ] Format refusal: non-image or corrupted files return 415 UNSUPPORTED_MEDIA.
- [ ] Size limit: file exceeding limit returns 413 FILE_TOO_LARGE.
- [ ] Validation: missing photo field returns 400 VALIDATION_ERROR.
- [ ] Photo cap: 9th photo on an item returns 422 TOO_MANY_PHOTOS.
- [ ] Deduplication: uploading identical photo to same item returns 409 DUPLICATE_PHOTO without leaving orphan storage files.
- [ ] Privacy: EXIF and GPS metadata stripped during processing; photos served only through authenticated routes.
- [ ] Draft lock: uploading or deleting photos on submitted/acknowledged inspections fails with 409 INSPECTION_LOCKED.
- [ ] Cascade delete: deleting an item cascades to delete media rows and deletes physical files from disk.
- [ ] Storage traversal defense: refusal of path traversal attempts outside UPLOAD_DIR.
- [ ] UI: thumbnail strip, loading="lazy", full-view in new tab, upload busy state, and deletion confirmation.
