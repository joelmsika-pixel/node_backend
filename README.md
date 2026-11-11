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
   npm run db:init
   npm run dev
   ```

   The API listens on `http://localhost:4000`. `GET /` returns API information
   and the frontend URL; `GET /api/health` checks the database connection.
   Database initialization is an explicit step and is not run when the API
   starts.
   `npm run build` type-checks and compiles it, and `npm start` starts the
   compiled server.
3. Set the frontend's `VITE_API_URL` to `http://localhost:4000/api` and run the
   Vue app on port 3000.
4. Configure `FRONTEND_URLS` with the exact browser origin(s). For password
   resets, also configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASSWORD`, and `SMTP_FROM`. Reset links are sent only when mail is
   configured.

`npm run db:init` creates the API access-token, refresh-token, and
password-reset tables and indexes using `CREATE ... IF NOT EXISTS`. Run this
command deliberately against the intended database; the service does not run
it on startup. It does not create the rest of the application schema. The
preserved `data/legacy.sqlite` file is an archive only; the API does not read
it.

Existing administrator accounts can sign in with their current password. To
create the first administrator on a new installation, run `npm run
create-admin` from this directory. The password prompt is hidden; use a
12-character minimum and run the command only from a trusted terminal.

## Deploy to Vercel

The Express application is exported from `src/server.ts` for Vercel. Local
development and `npm start` use `src/local.ts` to run a persistent listener.
Vercel's Express framework support discovers the app directly, so this project
does not need a `vercel.json`.

Before deploying, make sure the hosted PostgreSQL database has the existing
application schema and data expected by this API. This repository does not
include migrations for that schema. After verifying the target connection,
run `npm run db:init` separately to create the three API authentication/reset
tables if they are missing. Do not run that command as part of the Vercel
build.

In Vercel:

1. Import this repository from GitHub and use the repository root as the
   project root. Select the Express framework preset (or accept detection).
2. Leave the Output Directory unset. Use `npm install` and `npm run build` for
   install and build commands.
3. Add the environment variables below for Production, and for Preview if
   previews should use a database. Keep Preview and Production databases
   isolated where possible.
4. If using Vercel Marketplace, connect the PostgreSQL integration to this
   Vercel project and map its pooled connection string to the `DATABASE_URL`
   environment variable. If the integration names it differently (for example
   `POSTGRES_URL`), set `DATABASE_URL` to that value in Vercel. For Neon, use
   the pooled connection string supplied by the integration; do not copy it
   into source control. The provider URL should include its required SSL
   parameters.
5. Deploy from the connected Git repository. Pushes to the configured
   production branch create production deployments; other branches create
   previews.

Required Vercel variables:

- `DATABASE_URL` — the hosted PostgreSQL connection string, preferably the
  provider's pooled URL.
- `FRONTEND_URLS` — comma-separated, exact browser origins including scheme,
  such as `https://app.example.com`. Set all allowed origins.

Optional variables:

- `DB_POOL_SIZE` — per-instance `pg` pool size; defaults to `3` on Vercel and
  `10` locally. Keep this modest and use the provider's pooled URL.
- `DB_SSL=true` — explicitly require certificate-validated TLS if the URL
  does not specify SSL. Provider URLs commonly specify SSL themselves.
- `TRUST_PROXY=true` — only if the deployment's proxy setup requires Express
  to trust one proxy hop.
- `BUSINESS_CURRENCIES`, `ACCESS_TOKEN_EXPIRATION_MINUTES`, and
  `REFRESH_TOKEN_EXPIRATION_DAYS` — API defaults are documented in
  `.env.example`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and
  `SMTP_FROM` — configure these to enable password reset emails. Legacy `MAIL_*`
  aliases are also accepted by the application.

After deployment, check `GET https://<deployment-domain>/` for API metadata,
then `GET https://<deployment-domain>/api/health` for database connectivity.
The health endpoint must return a connected database status. Test login and
other authenticated routes using a valid account and bearer token, and verify
password reset only after SMTP is configured.

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
