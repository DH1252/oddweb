# Oddweb

Oddweb is a curated directory of unusual websites. It runs as a TanStack Start application on Cloudflare Workers, with D1 for relational data and R2 for thumbnails.

## Requirements

- Node.js 24.14.x or newer Node 24
- npm 11.9.0
- A Cloudflare account for remote operations

## Local Development

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Local D1 and R2 data are stored under `.wrangler/state`. Generate an admin password hash with `npm run auth:hash`, then set `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and a random `ADMIN_SESSION_SECRET` of at least 32 characters in `.dev.vars`.

Run the complete secret-free release verification with:

```bash
npm run verify
```

This validates release metadata and migrations, regenerates routes, checks formatting, runs ESLint and TypeScript, verifies generated Worker types, audits dependencies, runs tests, builds production output, and performs a strict Wrangler deployment dry run.

The audit strategy has two gates: all production dependencies fail on moderate or higher advisories, and the full dependency tree fails on high or critical advisories. `drizzle-kit` currently retains a moderate, development-server-only transitive `esbuild` advisory (`GHSA-67mh-4wv8-2f99`) with no safe upgrade offered by npm; the full audit remains visible without blocking on that known dev-only advisory. Re-evaluate this exception whenever `drizzle-kit` or its loader dependencies change.

## Database Migrations

Create a migration after changing the Drizzle schema:

```bash
npm run db:generate
```

Review and commit the generated SQL before applying it. Apply migrations locally with `npm run db:migrate`. Inspect and apply production migrations explicitly with:

```bash
npm run db:migrations:remote:check
npm run db:migrate:remote
```

Production deployment uploads an inactive Worker version before applying migrations, then promotes that exact version only after migrations succeed. Additive migrations leave the current Worker serving normally. A reviewed migration marked `release: maintenance-required` first deploys a minimal 503 maintenance Worker, applies the migration, and then promotes the application, preventing old code from running against a rebuilt schema.

Use expand/migrate/contract changes across separate releases: first add nullable columns/tables/indexes, then deploy code that can read both shapes and backfill data, and only remove old schema in a later release after rollback to old code is no longer required. The release check rejects unmarked table/column drops and renames. A reviewed SQLite table rebuild must carry the `release: maintenance-required` marker and is released through the maintenance path.

SQLite table rebuilds (`CREATE ..._new`, copy, drop, rename) are contract migrations. Split them into additive columns/indexes/triggers where possible. When a rebuild is required, the release script provides a bounded maintenance response and restores the previous Worker if migration application fails; the pre-release D1 export remains the database recovery point.

## R2 Thumbnails

The `THUMBNAILS` binding targets `oddweb-thumbnails`. Inspect or manage objects with Wrangler, for example:

```bash
npx wrangler r2 bucket info oddweb-thumbnails
npx wrangler r2 object get oddweb-thumbnails/<object-key> --file <local-file>
```

Do not place credentials or uploaded production objects in the repository.

## Production Release

Canonical production URL: <https://oddweb.page>

Authenticate Wrangler and configure secrets interactively:

```bash
npx wrangler login
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put ADMIN_SESSION_SECRET
```

Set an absolute backup directory outside the repository. `npm run deploy` refuses to continue without it, exports D1 before any migration, verifies the export is non-empty, and writes SHA-256 and JSON provenance sidecars:

```bash
export BACKUP_DIR=/absolute/path/to/secured/oddweb-backups
npm run deploy
```

The release command requires a clean worktree whose `HEAD` exactly matches its configured upstream. It runs all verification gates, records the commit SHA and UTC release time, uploads a strict inactive version tagged with that provenance, applies pending remote D1 migrations through either the additive or maintenance path, promotes the tagged version to 100%, and smoke-tests bindings, canonical metadata, robots, sitemap, structured data, real 404 handling, and private-route noindex controls. Additive-release smoke failures restore the previous Worker. Contract-migration failures keep maintenance active because old code may no longer match the database; restore the verified D1 backup or fix forward before serving traffic. `PRODUCTION_URL` must remain the canonical origin. Do not run the final command from CI without an intentional production approval and Cloudflare credentials.

The production Worker disables its `workers.dev` endpoint and per-version preview URLs. `oddweb.page` is the only indexable origin; `www` must permanently redirect to it. Production smoke tests require both alternate-host policies and fail if either regresses. `/health` is an uncached deployment marker reporting environment, release SHA, and release time. Operational errors use structured object logs; invocation logs are sampled at 10% and traces at 1% in Cloudflare observability. Wrangler uploads generated source maps so persisted stack traces resolve to application source; source maps are not served as public static assets.

## SEO Operations

The canonical host is `https://oddweb.page`. Before releasing, run `npm run verify`; after a production or staging release, run the applicable smoke command. For an already-running local server, use `node scripts/smoke-test.mjs --local` and optionally set `LOCAL_URL`. The release smoke gate validates `/robots.txt`, `/sitemap.xml`, homepage and detail metadata, JSON-LD parsing, and noindex controls for admin, login, health, and errors.

Tag filtering remains dynamic and D1-driven. Search/filter query variants are noindex and canonicalize to their unfiltered directory page; the application does not publish hardcoded tag landing pages.

After the custom domain is live:

- Add `oddweb.page` as a Google Search Console Domain property using DNS verification. Import it into Bing Webmaster Tools or verify the same domain there.
- Submit `https://oddweb.page/sitemap.xml` in both consoles. Inspect the homepage and representative detail URLs after the first release, then request indexing only after the live URL reports the intended canonical.
- Monitor indexing, duplicate-canonical reports, crawl errors, Core Web Vitals, and sitemap processing after releases. Investigate unexpected indexed `/admin`, `/health`, filtered query, `www`, or `workers.dev` URLs.
- Enable Cloudflare Web Analytics for the canonical hostname through the dashboard if desired. Treat its beacon or automatic injection as an operator setting and verify the Content Security Policy and browser console after enabling it; no analytics token belongs in this repository.
- Review titles, descriptions, social previews, structured data, robots, and sitemap output whenever routes, the canonical host, or site records change.

Manual DNS and Cloudflare setup is intentionally not automated by this repository:

1. Add and activate `oddweb.page` in the intended Cloudflare zone.
2. Attach `oddweb.page` as the Worker custom domain. Add `www.oddweb.page` only if it redirects permanently to `https://oddweb.page`; do not serve an independently indexable copy.
3. Confirm DNS is proxied, Universal SSL is active, and HTTPS works before changing public links or submitting the sitemap.
4. Configure a permanent `www` redirect and keep the `workers.dev` endpoint disabled.
5. Run `PRODUCTION_URL=https://oddweb.page npm run release:smoke` after DNS and routing settle. The command always verifies `www.oddweb.page` and the disabled `oddweb.oddweb.workers.dev` endpoint; optional environment variables may override those diagnostic URLs. This command is read-only.

## Staging

Staging must use isolated D1 and R2 resources. Resource creation remains an explicit operator task; this repository does not invent or provision IDs. Copy `staging.env.example` outside the repository or replace its placeholders locally after provisioning:

```bash
npx wrangler d1 create oddweb-staging
npx wrangler r2 bucket create oddweb-thumbnails-staging
```

Generate and validate an executable, gitignored Wrangler config from explicit values:

```bash
set -a
. /secure/path/staging.env
set +a
npm run staging:verify
```

The generated config is `.wrangler/staging.jsonc` and targets the production build output created by `npm run staging:verify`. Configure all three admin secrets against that config, apply migrations, deploy strictly, then smoke-test:

```bash
npx wrangler secret put ADMIN_USERNAME --config .wrangler/staging.jsonc
npx wrangler secret put ADMIN_PASSWORD_HASH --config .wrangler/staging.jsonc
npx wrangler secret put ADMIN_SESSION_SECRET --config .wrangler/staging.jsonc
npx wrangler d1 migrations list "$STAGING_D1_DATABASE_NAME" --remote --config .wrangler/staging.jsonc
npx wrangler d1 migrations apply "$STAGING_D1_DATABASE_NAME" --remote --config .wrangler/staging.jsonc
npx wrangler deploy --config .wrangler/staging.jsonc --strict
npm run staging:smoke
```

Run staging checks for schema changes and risky operational changes before production. Staging data must be synthetic or separately sanitized; never bind staging to production D1 or R2.

## Rollback

List versions and roll back Worker code with:

```bash
npx wrangler versions list
npx wrangler rollback <version-id>
```

A failed post-deploy smoke test exits nonzero but does not automatically roll back because schema/data recovery requires operator judgment. Inspect `/health`, `npx wrangler tail --format json`, recent versions, and deployment status before choosing rollback.

A Worker rollback does not reverse D1 migrations or R2 changes. Prefer forward-compatible migrations and a corrective forward migration. D1 Time Travel is always available for supported production databases; capture a bookmark before destructive recovery and follow Cloudflare's current retention policy. To restore an exported SQL backup, first preserve the failed state, stop or block writes, record the recovery point and expected data-loss window, then execute the reviewed backup file:

```bash
sha256sum -c /absolute/path/to/backup.sql.sha256
npx wrangler d1 export oddweb --remote --output /absolute/path/to/pre-restore.sql
npx wrangler d1 execute oddweb --remote --file /absolute/path/to/backup.sql
```

SQL import may conflict with existing schema/data and is not an atomic replacement workflow; review the export before execution. Prefer `npx wrangler d1 time-travel restore oddweb --bookmark <bookmark>` for coordinated point-in-time recovery when applicable, and record the returned previous bookmark so the restoration can itself be undone.

## Compatibility Maintenance

- Review Node LTS and npm pins monthly and update `package.json`, `package-lock.json`, and CI together.
- Review pinned GitHub Action SHAs and comments monthly; never replace immutable SHAs with floating tags.
- Run `npm outdated`, `npm audit`, and `npm run verify` during dependency maintenance. Remove the documented dev-audit exception as soon as a safe dependency path exists.
- Review Cloudflare's compatibility-date changes before advancing `compatibility_date`; validate locally and in isolated staging first.
- Update Wrangler and generated Worker types together, then confirm `upload_source_maps`, strict upload, version tags, and deployment commands remain supported.
- Keep migrations additive for at least one full release/rollback interval. Contract only after production and staging no longer run code that references the old shape.
