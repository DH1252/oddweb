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

Local D1 and R2 data are stored under `.wrangler/state`. Generate an admin password hash with `npm run auth:hash`, then set `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and a random `ADMIN_SESSION_SECRET` of at least 32 characters in `.dev.vars`. Regenerate older password hashes that use more than 100,000 PBKDF2 iterations; the Workers runtime does not support them.

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

Production deployment first asks Wrangler for the unapplied D1 migration list. After verification it copies the Vite-generated server/client output and maintenance Worker into a release-specific `.wrangler` artifact, rebases every generated config to immutable inputs, and dry-runs the exact production, cron-deferred, previous-trigger, and migration-aware maintenance configs before changing remote state. A code-only release uploads that verified artifact as an inactive Worker version without exporting D1. Every release clears cron schedules and pauses queue delivery when it was initially running before promoting new application code. Releases with pending D1 or Durable Object lifecycle migrations additionally deploy the fetch-only 503 Worker, set `app_state['release:maintenance']` for the global request barrier, wait for HTTP stabilization, and drain all taxonomy job and outbox leases, including expired lease rows, before recording the recovery point. The barrier remains set through backup and migration and is cleared only after the new application is active immediately before its smoke test. The application passes that gate while asynchronous delivery is held, and only then are production triggers and queue consumer settings reconciled, postdeploy checks run, and queue delivery restored to its asserted initial state for the trigger-aware smoke gate.

Use expand/migrate/contract changes across separate releases: first add nullable columns/tables/indexes, then deploy code that can read both shapes and backfill data, and only remove old schema in a later release after rollback to old code is no longer required. The release check rejects unmarked table/column drops and renames. A reviewed SQLite table rebuild must carry the `release: maintenance-required` marker and is released through the maintenance path.

SQLite table rebuilds (`CREATE ..._new`, copy, drop, rename) are contract migrations. Split them into additive columns/indexes/triggers where possible. When a rebuild is required, the release script provides a bounded maintenance response and keeps maintenance active if migration application or verification fails; the under-maintenance D1 export and recorded Time Travel bookmark are the database recovery points.

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
npx wrangler secret put TAXONOMY_MASTER_KEY_V1
```

Set an absolute recovery directory outside the repository. Because Wrangler 4.120.1 may omit `delivery_paused`, inspect the production taxonomy queue in Cloudflare and explicitly declare whether it is currently `running` or `paused` with `RELEASE_TAXONOMY_QUEUE_INITIAL_STATE`; the release restores that state and records it in the journal. `npm run deploy` refuses to continue without the recovery directory, Cloudflare credentials, and a queue-state declaration when the API omits state. Code-only releases write a JSON recovery journal containing the pre-release D1 Time Travel bookmark and do not export D1. Releases with pending D1 migrations first activate maintenance, set the D1 request barrier, and drain taxonomy leases, then export D1, verify that the export is non-empty, and write SHA-256 and JSON provenance sidecars:

```bash
export BACKUP_DIR=/absolute/path/to/secured/oddweb-backups
export CLOUDFLARE_ACCOUNT_ID=your-account-id
export CLOUDFLARE_API_TOKEN=production-release-token
export RELEASE_TAXONOMY_QUEUE_INITIAL_STATE=running
npm run deploy
```

The production release token must cover the account and zone used by this project, including Workers Scripts, Workers Routes Edit, Queues, D1, R2, and Worker secret metadata. A successful release that starts with queue delivery running pauses it, restores production triggers, resumes the release-owned pause while the D1 release lease is still held, and runs the functional cron/outbox/queue probe before returning success. A queue that was already paused remains paused and receives read-only trigger verification.

Migration releases require the active Worker to expose release fence version 1.
After introducing or upgrading the fence protocol, deploy once with no pending D1
or Durable Object migrations before running a migration-bearing release.

The release command requires a clean worktree whose `HEAD` exactly matches its configured upstream, repeats that check after route generation and verification, and checks it again immediately before the first remote mutation. Predeploy remote validation checks provisioned resources only, so a fix-forward release can start while the fetch-only maintenance Worker is active; deployed handlers, bindings, queue consumer, DLQ, consumer settings, and secret metadata are validated after promotion. The release journal is written before the first mutation and records the initial queue state, barrier transitions, stabilization and lease drain, recovery point, migrations, application promotion, trigger restoration, final queue state, completion, and containment failures. The release compares the active Worker version's supported `migration_tag` metadata with the configured Durable Object migration list. Historical, already-applied Durable Object migrations therefore continue through inactive version upload; only a genuinely pending lifecycle migration uses direct deployment of the verified built artifact under maintenance. A first-gate code-only failure restores the previous code and reconstructable routes/crons plus the exact live pre-release consumer snapshot, then restores queue delivery only if every restoration step succeeds. A release aborts before mutation if the previous routes and cron schedules cannot be reconstructed from the active release SHA. A trigger-gate failure keeps queue delivery paused and cron schedules cleared. Durable Object lifecycle changes are forward-only in this workflow: Cloudflare does not permit rollback across a lifecycle migration, so keep maintenance active, keep the D1 barrier set, and fix forward at the active migration tag. `PRODUCTION_URL` must remain the canonical origin. Do not run the final command from CI without an intentional production approval and Cloudflare credentials.

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

Staging must use an isolated Worker, D1 database, R2 bucket, taxonomy queue, and taxonomy DLQ. Queue names must be distinct, non-production names prefixed with `STAGING_WORKER_NAME`. Resource creation remains an explicit operator task; this repository does not invent or provision IDs. Provision all four storage and messaging resources, then copy `staging.env.example` outside the repository and fill in the returned D1 ID and chosen names:

```bash
npx wrangler d1 create oddweb-staging
npx wrangler r2 bucket create oddweb-thumbnails-staging
npx wrangler queues create oddweb-staging-taxonomy
npx wrangler queues create oddweb-staging-taxonomy-dlq
```

Generate and validate an executable, gitignored Wrangler config from explicit values. `staging:verify` validates local configuration and the pre-provisioned D1, R2, queue, and DLQ, but intentionally does not require a deployed Worker or remote handlers, so it works before the first deployment:

```bash
set -a
. /secure/path/staging.env
set +a
npm run staging:verify
```

The generated config is `.wrangler/staging.jsonc` and targets the production build output created by `npm run staging:verify`. It records the current Git SHA and generation time. Wrangler cannot set required secrets before a Worker exists, so the first deployment must supply all four secrets atomically through a secured `.env` or JSON file outside the repository. The file must be readable only by its owner and define `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, and a 32-byte base64url `TAXONOMY_MASTER_KEY_V1`:

```bash
chmod 600 /secure/path/staging-secrets.env
export STAGING_SECRETS_FILE=/secure/path/staging-secrets.env
npm run staging:deploy:first
```

`staging:deploy:first` validates all four required secret keys before remote work, runs staging verification, requires a clean worktree, hashes the config, server, client, and secrets, and dry-runs the exact strict `--secrets-file` deployment before any mutation. It rechecks cleanliness and the digest before applying isolated D1 migrations and again before deployment, then validates handlers/consumer settings and smoke-tests the exact staging release SHA. Use the ordinary staging verification and deployment controls for later changes; never commit or place the secrets file under the repository.

Run staging checks for schema changes and risky operational changes before production. Staging data must be synthetic or separately sanitized; never bind staging to production D1 or R2.

## Rollback

List versions and roll back Worker code with:

```bash
npx wrangler versions list
npx wrangler rollback <version-id>
```

A failed code-only application smoke restores the previous Worker and its committed trigger/consumer configuration, then resumes delivery only after those restoration steps validate. A failed trigger-aware smoke intentionally leaves taxonomy delivery paused and cron schedules cleared for explicit recovery. A failed migration-path smoke keeps the maintenance Worker active because schema/data recovery requires operator judgment. If a Durable Object lifecycle migration was applied, do not attempt to deploy the previous version; Cloudflare blocks that rollback and the application must be fixed forward at the active migration tag. Inspect `/health`, `npx wrangler tail --format json`, recent versions, deployment status, and the recorded release recovery journal before intervening.

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
