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

- [ ] Item CRUD in draft status: create, patch, delete, get inspection items.
- [ ] Unique item constraint: duplicate room and name (case-insensitive) returns 409 DUPLICATE_ITEM.
- [ ] Item cap: creating beyond 300 items per inspection returns 422 TOO_MANY_ITEMS.
- [ ] Inspection lock trigger: updating, deleting, or inserting items when inspection status is not draft fails with 409 INSPECTION_LOCKED (`LOCKED:...`).
- [ ] Item immutability: attempting to change an item's `inspection_id` fails.
- [ ] Strict inspections guard: any update on an acknowledged inspection fails.
- [ ] Concurrency: draft lock during status transition blocks concurrent item creation until resolution.
