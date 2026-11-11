# Biashara Manager Node Backend

TypeScript/Node.js API using Express and PostgreSQL. The API connects to the
existing PostgreSQL database and records payments received outside the
application; it does not process money.

## Run locally

1. Copy `.env.example` to `.env` when starting fresh, then set the PostgreSQL
   values to your database. Do not copy production secrets into source control.
2. From this directory, install dependencies and start the API:

   ```sh
   npm install
   npm run dev
   ```

   The API listens on `http://localhost:4000`. `GET /` returns API information
   and the frontend URL; `GET /api/health` checks the database connection.
   `npm run build` type-checks and compiles it, and `npm start` starts the
   compiled server.
3. Set the frontend's `VITE_API_URL` to `http://localhost:4000/api` and run the
   Vue app on port 3000.
4. Configure `FRONTEND_URLS` with the exact browser origin(s). For password
   resets, also configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASSWORD`, and `SMTP_FROM`. Reset links are sent only when mail is
   configured.

On first start, the service creates its API access-token, refresh-token, and
password-reset tables in PostgreSQL. These tables are managed by the Node
service.
The preserved `data/legacy.sqlite` file is an archive only; the API does not
read it.

Existing administrator accounts can sign in with their current password. To
create the first administrator on a new installation, run `npm run
create-admin` from this directory. The password prompt is hidden; use a
12-character minimum and run the command only from a trusted terminal.

## API outline

- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `POST /api/token/refresh`
- `POST /api/forgot-password`, `POST /api/reset-password`
- `/api/admin/businesses` — Platform Admin only
- `/api/businesses/{business}` and its dashboard, reports, activity, debts,
  employees, inbox, customers, categories, payment methods, sales, payments,
  income, expenses, and loan routes

Business routes check active membership and permissions on the server. Tenant
records are scoped to the requested business. Write requests retain audit
records; sales, payments, loans, and loan repayments use database transactions
where balances must remain consistent.
