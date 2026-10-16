# Handover

A shared move-in and move-out condition record for rentals, where landlord deposit deductions link to specific items and the tenant can accept or dispute each one.

## Requirements

- Node.js >= 20.6
- PostgreSQL >= 14 (running locally)
- npm >= 10

## Setup

1. Clone repository and navigate to folder:

   ```bash
   git clone https://github.com/Ayush-o1/monarch.git
   cd monarch
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up environment variables:

   ```bash
   cp .env.example .env
   # Edit .env and ensure SESSION_SECRET has at least 32 characters
   ```

4. Create local PostgreSQL databases:

   ```bash
   createdb handover_dev
   createdb handover_test
   ```

5. Run database migrations:
   ```bash
   npm run migrate
   npm run migrate:test
   ```

## Running Locally

- Development mode with auto-reload:

  ```bash
  npm run dev
  ```

  Open `http://localhost:3000` in your browser.

- Production mode:
  ```bash
  npm start
  ```

## Testing & Quality

- Run tests:

  ```bash
  npm test
  ```

- Run linter:

  ```bash
  npm run lint
  ```

- Check formatting:

  ```bash
  npm run format:check
  ```

- Fix formatting:
  ```bash
  npm run format
  ```

## Legal Notice

Handover records what the parties entered and acknowledged. It is not legal advice.
