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

## Products and Cloudflare R2 images

Product routes are scoped to `/api/businesses/{business}/products`. The API
checks the existing `products.view`, `products.create`, `products.edit`, and
`products.delete` membership permissions on every request. Owners are
authorized by the existing owner rule. The product migration adds these four
permissions to current employee memberships; newly created employees receive
them by default.

After confirming that the target PostgreSQL database has the existing
`businesses`, `users`, and `business_user` tables, review their ID and
permissions column types and take a verified backup. The migration checks
these prerequisites and runs product DDL and employee-permission updates in
one transaction. It creates only the missing `products`, `product_images`,
and `product_image_cleanup` objects; it does not drop or rewrite application
tables or product data. Run it explicitly from this directory against the
intended database:

```sh
npm run db:migrate-products
```

The reviewed SQL is also available at
[`migrations/20261113_products_and_images.sql`](./migrations/20261113_products_and_images.sql).
This command is not run at startup, during build, or during deployment. For
production, run it from a trusted environment configured with the production
database URL only after verifying the URL target and backup. Confirm that it
reports success before deploying product-enabled API code. The DDL is
idempotent for absent tables/indexes; the migration fails before DDL if base
table prerequisites do not match.

Configure these backend environment variables before uploading images:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME=biashara-manager-products`
- `R2_PUBLIC_URL` — the public bucket custom-domain/base URL used to serve
  product images (without a trailing slash).
- `R2_ENDPOINT` — the Cloudflare R2 S3 API endpoint, normally
  `https://<account-id>.r2.cloudflarestorage.com`. If omitted, the API derives
  it from `R2_ACCOUNT_ID`.

Create a Cloudflare R2 bucket and a public custom domain (or other approved
public-read configuration) for `R2_PUBLIC_URL`. Use a least-privilege R2 token
for that bucket. Keep the access key and secret only in the backend's
environment; never add them to frontend variables or source control. Restart
the API after configuring its environment.

Uploads accept up to 5 JPG/JPEG, PNG, WebP, or SVG images per product. Each
raster image may be up to 8 MiB; each SVG may be up to 2 MiB; the combined
source upload may be up to 40 MiB. Source images are limited to 8,000 pixels
per side and 40 megapixels. The backend validates and rasterizes SVG, strips
metadata by re-encoding, converts images to WebP, resizes main images to at
most 1,200 × 1,200 pixels, and creates 320-pixel thumbnails. It reduces
quality/dimensions as needed to cap each main WebP at 200,000 bytes; very
complex images that cannot meet that cap are rejected with an actionable
error. Stored object keys are namespaced by business and product. Replaced
images and deleted products are cleaned from R2; failed cleanup is retained
for retry and reported to the client.

The frontend displays client-side previews and upload progress, but validation
and authorization are enforced again on the backend. Run `npm test` in this
directory to build the API and test image-format validation, SVG safety,
dimension limits, WebP conversion, and thumbnail generation. Live database
and R2 checks require the deployment's own configured infrastructure.

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

1. Import this repository from GitHub and set the Vercel project Root
   Directory to `node_backend`. Select the Express framework preset (or accept
   detection).
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
- Ensure the database URL hostname matches its TLS certificate. Legacy
  `sslmode=prefer`, `sslmode=require`, and `sslmode=verify-ca` are normalized
  to `sslmode=verify-full`; `sslmode=no-verify` is rejected. Do not disable
  certificate verification.

Optional variables:

- `DB_POOL_SIZE` — per-instance `pg` pool size; defaults to `3` on Vercel and
  `10` locally. Keep this modest and use the provider's pooled URL.
- `DB_SSL=true` — explicitly require certificate-validated TLS for a
  non-Vercel connection URL.
- `TRUST_PROXY=true` — only for a trusted single-proxy non-Vercel deployment.
  Vercel automatically trusts one proxy hop. Do not configure trust for all
  proxies. All rate limiters use the trusted Express client IP and ignore
  caller-supplied `Forwarded` values and bearer tokens as rate-limit keys.
- `BUSINESS_CURRENCIES`, `ACCESS_TOKEN_EXPIRATION_MINUTES`, and
  `REFRESH_TOKEN_EXPIRATION_DAYS` — API defaults are documented in
  `.env.example`.
- Sessions expire after 15 minutes without user activity. Authenticated API
  requests and `POST /api/session/activity` extend the refresh-token idle
  expiration. Access tokens keep their configured lifetime, and refresh tokens
  retain their configured maximum lifetime.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and
  `SMTP_FROM` — configure these to enable password reset emails. Legacy `MAIL_*`
  aliases are also accepted by the application.

After deployment, check `GET https://<deployment-domain>/` for API metadata,
then `GET https://<deployment-domain>/api/health` for database connectivity.
The health endpoint must return a connected database status. Test login and
other authenticated routes using a valid account and bearer token, and verify
password reset only after SMTP is configured.

### Product and deployment verification checklist

After running the explicit product migration and deploying:

1. `GET /` returns API metadata and `GET /api/health` reports a connected
   database.
2. `POST /api/login` with a test account returns a token pair;
   `POST /api/token/refresh` with that test refresh token rotates the pair;
   `GET /api/me` with the access token returns the user and businesses.
3. `GET /api/businesses/{business}/products` returns a paginated product list
   for a member with `products.view`. Verify an unrelated business ID remains
   inaccessible and users without permission remain forbidden.
4. With a disposable product and configured test R2 bucket, create it with an
   image, replace/remove an image, and delete the product. Confirm successful
   R2 cleanup removes soft-deleted image rows; temporarily deny R2 deletion in
   staging and confirm cleanup rows remain for retry.
5. In staging, verify rate-limit headers and per-client limits; confirm Vercel
   logs no `ERR_ERL_FORWARDED_HEADER` or `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.
   Do not load-test production.
6. Confirm Vercel runtime logs have no PostgreSQL SSL-mode compatibility
   warning and that the provider accepts the verified TLS connection.
7. Recheck business, customer, sales, expense, and loan list/read endpoints
   using existing test records.

Do not use production account tokens or real customer records for this test
plan. The repository build and automated tests do not have access to Vercel's
environment or production PostgreSQL/R2 services; those checks must be
performed after the reviewed migration and deployment.

Unexpected API failures return a generic error response and write a structured
`api.unhandled` entry with a redacted stack trace to the deployment runtime
logs. Use those logs to diagnose production failures; do not include request
headers, tokens, or environment values when sharing log excerpts.

## API outline

- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `POST /api/token/refresh`
- `POST /api/forgot-password`, `POST /api/reset-password`
- `/api/admin/businesses` — Platform Admin only
- `/api/businesses/{business}` and its dashboard, reports, activity, debts,
  employees, inbox, customers, categories, payment methods, products and
  product-image uploads, sales, payments, income, expenses, and loan routes

Business routes check active membership and permissions on the server. Tenant
records are scoped to the requested business. Write requests retain audit
records; sales, payments, loans, and loan repayments use database transactions
where balances must remain consistent.
