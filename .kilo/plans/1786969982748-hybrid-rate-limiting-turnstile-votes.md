# Hybrid Public Abuse Protection Plan

## Goal

Protect both public content forms with Turnstile plus layered Worker rate limits, while keeping votes Turnstile-free, anonymous, unique per signed browser identity, and resistant to cookie resets and automated vote inflation.

## Decisions

- Protect **site submissions** and **guestbook entries** with Turnstile; do not challenge votes, surprise navigation, or visit accounting.
- Fail closed if Siteverify is unavailable, invalid, expired, replayed, has the wrong action, or returns an unapproved hostname.
- Use separate production and staging widgets. Production allows `oddweb.page`; staging allows its isolated origin plus `localhost` and `127.0.0.1`. Production hostname validation must never allow local hosts.
- Assume Cloudflare Free/Pro: Worker/D1 enforcement is mandatory; do not depend on WAF `cf.unique_visitor_id`, Bot Management, JA3/JA4, or Enterprise Turnstile Ephemeral IDs.
- Anonymous vote identity uses a one-year signed, `HttpOnly`, `Secure` in HTTPS, `SameSite=Lax`, `Path=/` first-party cookie. First vote is immediate. Votes remain toggleable with a per-site cooldown.
- Anonymous identity is abuse-resistant, not proof of a human. Clearing cookies creates a new identity; IP/network and global controls bound that escape hatch.

## Implementation

1. **Provision Turnstile safely**
   - Follow the Turnstile Spin guarded workflow: probe `Account.Turnstile:Edit`, confirm the account/domain manifest, and create separate managed widgets for production and staging.
   - Stable actions: `site_submission` and `guestbook`.
   - Store public sitekeys in deployment-specific build/runtime configuration and secrets as Worker secret `TURNSTILE_SECRET`; add `TURNSTILE_HOSTNAMES` as deployment-specific config.
   - Add `TURNSTILE_SECRET` to `wrangler.jsonc` required secrets, staging config generation, first-deploy secret validation, release resource checks, Worker types, and release tests. Never write or log the secret.

2. **Add reusable anonymous identity middleware/helper**
   - Create a small server module using TanStack Start `useSession`, separate from admin auth, with cookie name/version such as `__Host-oddweb-public-v1` on HTTPS and `oddweb-public-v1` locally.
   - Store only a random 128-bit+ identity ID and issuance timestamp; sign/encrypt with `ADMIN_SESSION_SECRET`, set one-year max age, and rotate the cookie name/schema to revoke globally.
   - Derive D1 keys with domain-separated HMACs (`public-limit:<action>:<identity>`, `vote:<identity>`); never store raw cookie IDs or raw IPs.
   - For absent/invalid cookies, mint once and continue immediately. For IP/network fallback derive privacy-preserving buckets from `CF-Connecting-IP`: exact HMAC for short velocity control plus coarse IPv4 `/24` or IPv6 `/64` HMAC for cookie-reset/farm detection. Keep raw addresses out of D1/logs.

3. **Turnstile-gate both public forms**
   - Add an explicit-render React Turnstile component with one widget instance per form, its own widget ID/token, accessible pending/error states, and reset after every accepted or rejected request because tokens are single-use and expire after five minutes.
   - Site submission dialog submits `turnstileToken` with its existing form payload; guestbook submits the token with its current input. Preserve existing handler logic and optional image behavior.
   - Add a canonical server validator that calls `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 10s timeout, `TURNSTILE_SECRET`, token, remote IP, and an idempotency UUID. Require `success`, exact action, and hostname allowlist. Reject missing/oversized tokens before the call. Return retryable user-facing failure without persisting data.
   - Add CSP entries for `https://challenges.cloudflare.com` to `script-src` and `frame-src`; retain Cloudflare Web Analytics allowance. Do not call Siteverify from the browser.
   - Ensure a failed submission resets only that form's widget and does not reuse the redeemed token.

4. **Replace the public limiter with a layered hybrid policy**
   - Generalize `public_submission_attempts` to a neutral name (migration plus schema/repository updates) or introduce a new generic attempt table; store action/scope/key/time so cleanup and operational queries are explicit.
   - Enforce scopes atomically before expensive writes:
     - signed identity + action (primary fairness bucket),
     - exact-IP HMAC + action (generous cookie-reset fallback),
     - coarse network HMAC + action (high ceiling, anomaly/farm containment),
     - site-wide action cap (distributed abuse containment).
   - Count successful Turnstile validation attempts only after token verification; refund all consumed buckets when the existing persistence/upload operation fails. Invalid Turnstile attempts are tracked separately with bounded retention so they cannot exhaust legitimate submission quotas.
   - Initial conservative ceilings, configurable in one policy object and adjusted from production telemetry:
     - site submission: identity 6/3h; exact IP 24/3h; network 120/3h; global 300/3h;
     - guestbook: identity 3/day; exact IP 12/day; network 80/day; global 500/day;
     - votes: handled in step 5.
   - Preserve `429` + maximum applicable `Retry-After`; use `403` for invalid challenges and `503` for Siteverify/configuration outages.

5. **Migrate votes from IP identity to a durable anonymous vote ledger**
   - Treat current uncommitted vote work (`site_votes`, `toggleSiteVote`, vote UI, migration `0012_votes.sql`) as the migration baseline; do not discard it.
   - Replace the IP-derived `visitorKey` in `src/server/data.ts` with the signed identity's HMAC key. The `site_votes(site_id, visitor_key)` unique constraint remains the authoritative one-vote-per-identity-per-site invariant.
   - Because existing vote rows are IP-derived and cannot be mapped to cookie identities, keep them as historical aggregate votes, but do not return them from `getMyVotedSlugs`. Add an identity-scheme/version column or prefix so future rotations and historical rows are distinguishable.
   - Make vote toggling atomic in one D1 transaction/batch to prevent concurrent delete/insert races; return authoritative `voted` and count. Add `updated_at`/last-toggle data or a separate action ledger.
   - Apply a 30-second per-identity/site toggle cooldown; idempotent retries return current state rather than flipping twice.
   - Layer vote limits without Turnstile:
     - identity: 30 vote state changes/hour and 200/day;
     - exact IP: 120/hour (CGNAT-tolerant fallback);
     - coarse network: 600/hour;
     - global: 5,000/hour;
     - per-site anomaly guard: suppress or quarantine excess new-identity votes when one network contributes an abnormal burst.
   - Add an identity activity record (`first_seen`, `last_seen`, bounded action counters). Do not delay first vote, but assign new-identity votes a lower trust flag for anomaly analysis. If abuse occurs, allow an operator policy to quarantine suspicious votes from ranking without deleting the ledger.
   - Compute public ranking from accepted/non-quarantined votes only. Do not seed fake production votes; existing zero-vote rows fall back deterministically to visits/name until real votes accumulate.

6. **Observability and privacy controls**
   - Emit structured events with action, decision, limiter scope, status, retry-after, Turnstile error code/action/hostname, cookie age bucket, and hashed network bucket; never log tokens, cookie IDs, voter keys, secret values, or raw IPs.
   - Add bounded retention cleanup for limiter attempts, Turnstile failure telemetry, identity activity, and vote anomaly records.
   - Document the first-party security/identity cookie and retention in the privacy notice/README. Explicitly state that clearing storage can create a new anonymous identity and that limits/anomaly controls may group shared networks.

7. **Deployment workflow integration**
   - Staging first: provision staging widget/secret/sitekey/hostname allowlist, update staging secret manifest/scripts, deploy, then validate both forms with fresh tokens and verify token replay rejection.
   - Production release remains `npm run deploy`; its preflight must reject missing Turnstile secret/config/sitekey and hostname drift before mutation/promotion.
   - Add production widget/secret only after staging passes. Avoid direct `wrangler deploy`.
   - Apply D1 migrations through the existing release workflow. Preserve the current dirty working tree and generated Drizzle metadata; regenerate migration metadata only after the final identity/vote schema is settled.
   - Roll back code-only failures through the release journal. If a migration was applied, fix forward unless the existing release policy explicitly permits restoration.

## Validation

- Unit tests: cookie mint/read/tamper/expiry/version, HMAC domain separation, IPv4/IPv6 network buckets, Turnstile result/action/hostname/error mapping, limiter scope/retry-after/refunds, vote cooldown/idempotency/quarantine.
- D1 tests: generic attempt migration, one vote per identity/site, concurrent toggle behavior, historical IP-key vote compatibility, ranking excludes quarantined votes, cleanup bounds.
- UI tests: independent widgets for site submission/guestbook, token included, reset after success/error, buttons disabled while verifying, votes never render Turnstile.
- Security tests: missing/forged/replayed/expired Turnstile token; wrong action/hostname; Siteverify timeout/non-JSON/non-2xx; cookie tamper/clear; rapid cookie resets from one exact/coarse network; multi-IP attack hitting global cap.
- Release tests: required secret manifests, staging/production hostname separation, CSP, Worker types, preflight/postdeploy, smoke path with a real token and one replay rejection per protected action.
- Run `npm run verify`, `npm run test:migrations`, `npm run test:drizzle-generation`, production build, and strict deploy dry run before staging deployment.

## Non-goals

- No accounts, OAuth, email verification, browser fingerprinting, Enterprise Ephemeral IDs, or Free/Pro-incompatible NAT-aware WAF dependency.
- No claim of perfect one-human/one-vote identity; the target is anonymous fairness with bounded, observable abuse.
