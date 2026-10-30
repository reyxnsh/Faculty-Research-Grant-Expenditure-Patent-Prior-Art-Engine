# Faculty Research Grant Expenditure & Patent Prior-Art Engine

A database-centric web application for university research administration. The platform tracks faculty research grants, manages account allocations and expenditure approvals under strict database-level constraints, and provides a vector similarity prior-art search engine for patent and publication disclosures.

## Prerequisites

- **Node.js**: v22+ (v26 recommended, see `.nvmrc`)
- **Docker Desktop**: for running PostgreSQL 16 with the `pgvector` extension

## Quick Start

1. **Clone and enter the repository:**
   ```bash
   cd Faculty-Research-Grant-Expenditure-Patent-Prior-Art-Engine
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set secure credentials for the database.

3. **Start the database container:**
   ```bash
   docker compose up -d
   ```

4. **Install dependencies:**
   ```bash
   npm install
   ```

5. **Run database migrations:**
   ```bash
   npm run migrate:up
   ```

6. **Start the development server:**
   ```bash
   npm run dev
   ```
   The application runs on `http://localhost:3000`.

## Testing

Run the test suite with Vitest:
```bash
npm test
```

## Useful Commands

- `npm run db:up`: Start the PostgreSQL container in the background
- `npm run db:down`: Stop the PostgreSQL container
- `npm run db:reset`: Reset database volume and re-run migrations
- `npm run migrate:up`: Apply pending migrations
- `npm run migrate:down`: Revert the last migration
- `npm run lint`: Run ESLint checks
- `npm run build`: Build production Next.js bundle
