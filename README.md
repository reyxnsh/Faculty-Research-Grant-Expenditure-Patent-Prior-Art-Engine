# Faculty Research Grant Expenditure & Patent Prior-Art Engine

A database-centric web application for university research administration. The platform tracks faculty research grants, manages account allocations and expenditure approvals under strict database-level constraints, and provides a vector similarity prior-art search engine for patent and publication disclosures.

## Prerequisites

- **Node.js**: v22+ (v26 recommended, see `.nvmrc`)
- **Docker Desktop**: for running PostgreSQL 16 with the `pgvector` extension

## Quick Start

1. **Clone and enter the repository:**
   ```bash
   git clone https://github.com/reyxnsh/Faculty-Research-Grant-Expenditure-Patent-Prior-Art-Engine.git && cd Faculty-Research-Grant-Expenditure-Patent-Prior-Art-Engine
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and configure:
   - Administrative database credentials (`DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`)
   - Restricted application-role credentials (`APP_DB_USER` and `APP_DB_PASSWORD`)
   - Authentication secret `AUTH_SECRET` (minimum 32 characters; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - Optional `SESSION_TTL_HOURS` (session lifespan in hours, defaults to 8)

3. **Start the database container:**
   ```bash
   npm run db:up
   ```
   This boots the PostgreSQL 16 container with `pgvector` and blocks until the container healthcheck passes.

4. **Install dependencies:**
   ```bash
   npm install
   ```

5. **Run database migrations:**
   ```bash
   npm run migrate:up
   ```

6. **Create an initial administrator account:**
   ```bash
   npm run create-admin -- --email admin@university.edu
   ```
   You will be asked to enter a password interactively in the terminal.
   > **Security Note**: We recommend entering the password interactively in the terminal. Passing `--password` on the command line records the plaintext password in shell history.

7. **Start the development server:**
   ```bash
   npm run dev
   ```
   The application runs on `http://localhost:3000`.

## API Request Requirements & CSRF Protection

- **Authentication**: Endpoints use HTTP-only cookies (`auth_session`) issued upon successful login at `POST /api/auth/login`.
- **CSRF & Header Requirements**: Every state-changing HTTP request (`POST`, `PUT`, `PATCH`, `DELETE`) must carry the header `Content-Type: application/json`, even for endpoints with empty or omitted request bodies (such as `/api/expenditures/:id/approve` or `/api/auth/logout`). Requests without this header are rejected with HTTP 403 Forbidden.

## Testing

Run the automated test suite with Vitest:
```bash
npm test
```

## Useful Commands

- `npm run db:up`: Start the PostgreSQL container and wait for healthy status
- `npm run db:down`: Stop the PostgreSQL container
- `npm run db:reset`: Reset database volume, wait for healthy status, and re-run migrations
- `npm run migrate:up`: Apply pending migrations
- `npm run migrate:down`: Revert the last migration
- `npm run create-admin`: Create or update an ADMIN account via CLI (interactive terminal input recommended)
- `npm run lint`: Run ESLint checks
- `npm run build`: Build production Next.js bundle
