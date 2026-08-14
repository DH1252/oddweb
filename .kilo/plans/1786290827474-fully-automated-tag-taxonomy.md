# Fully Automated Tag Taxonomy

## Goal

Replace the manual tag-wrangling workflow with a durable, provider-neutral automation system that autonomously classifies sites, corrects assignments, creates/aliases/merges tags, and maintains a bounded parent hierarchy. Preserve current public behavior during rollout, remove tag categories completely, and make every automated mutation auditable and reversible.

## Decisions

- D1 remains authoritative; queues/providers are processing infrastructure only.
- Use stored metadata and submitted tags only; never crawl submitted URLs.
- Keep tag inputs as untrusted classification hints and preserve raw hints.
- Publish approved/edited sites immediately with deterministic exact mappings, then enrich asynchronously.
- Automation may add, remove, canonicalize, merge, and replace any assignment, except durable admin-locked corrections.
- Remove `TagCategory` and the `tags.category` column plus every category reference.
- Retain parent/subtag relationships with configurable maximum depth/fan-out and existing cycle prevention.
- Preserve current D1 taxonomy as revision 1, then reassess it asynchronously.
- Novel canonical tags require configurable cross-site evidence; rare concepts remain valid standalone/unmapped tags.
- On repeated AI failure, settle conservatively: retain normalized tags/current assignments and schedule later reassessment.
- Implement OpenAI-compatible and Gemini providers behind one normalized interface. Admin controls endpoint/model/dialect/routing/policy; credentials are AES-GCM encrypted in D1 with a versioned Worker master secret and are never returned decrypted.
- Support provider routing modes from admin, including primary/failover and consensus for ontology mutations.
- Mandatory shadow evaluation precedes gradual autonomous writes; circuit breakers automatically return the system to shadow/degraded mode.
- Event-, site-run-, and batch-level rollback create compensating audit events rather than deleting history.
- New Cloudflare Queue, DLQ, and cron resources are included in code/config but provisioning, remote migrations, and deployment require explicit approval.

## Implementation Plan

1. **Define taxonomy invariants and pure contracts**
   - Split normalization primitives out of `src/data/tags.ts` into `src/taxonomy/normalize.ts`; retain deterministic normalization, slugging, exact canonical/name/alias resolution, reserved-slug checks, and stable metadata hashing.
   - Define strict Zod schemas in `src/taxonomy/contracts.ts` for provider-neutral site decisions and ontology proposals. Provider output references immutable numeric tag IDs for existing concepts and normalized proposal IDs for novel concepts; reject unknown IDs, extra properties, invalid actions, excessive assignments, self-links, cycles, and over-limit hierarchy changes.
   - Define bounded policy in `src/taxonomy/policy.ts`: assignment limit, evidence threshold, confidence/margin thresholds, hierarchy max depth/fan-out, provider agreement requirements, retry budget, rollout percentage, daily request/token budget, and circuit-breaker thresholds.
   - Treat provider confidence as an input, not truth. Final confidence combines exact hint match, provider agreement, repeated evidence, first/second margin, prior accepted evidence, and policy constraints.

2. **Add an additive D1 automation schema, then contract category removal later**
   - First migration must be additive and old-Worker-compatible. Add:
     - `taxonomy_state` with published version, active config, mode (`disabled|shadow|gradual|autonomous|degraded`), circuit-breaker state, and timestamps.
     - Immutable `taxonomy_provider_configs` with provider kind (`openai_compatible|gemini`), endpoint, model, OpenAI dialect (`responses|chat_completions`), routing priority/role, timeout, encrypted credential fields (`key_version`, nonce, ciphertext), enabled state, and revision.
     - Immutable/versioned `taxonomy_policy_configs` containing all safe admin controls and prompt/schema hashes.
     - `taxonomy_jobs`, attempts, outbox, candidates, change batches, append-only audit events, rollback links, and terminal/degraded states.
     - `taxonomy_concept_evidence` for novel-tag support across distinct sites and provider/config versions.
     - `tag_assignment_decisions` and effective assignment provenance; add stable assignment identity rather than relying on `(site_id, raw_name)` alone.
     - `taxonomy_locks` for admin-corrected site assignments, aliases, merges, and parent edges.
     - `sites.updated_at`, `content_version`, and `classification_input_hash`; `tags.status`, `revision`, timestamps, automation lock/deprecation/merge metadata.
   - Add indexes for pending jobs, leases, retry time, undispatched outbox rows, site/config hashes, evidence lookup, audit batches, and effective assignments.
   - Add/strengthen constraints and triggers for normalized unique aliases versus tag slugs, canonical-only parents, no graph cycles, bounded status values, assignment uniqueness, and immutable audit records. Depth/fan-out must also be rechecked transactionally at apply time.
   - Seed `taxonomy_state` revision 1 from current D1 tags/aliases/parents and write a migration audit batch without changing public behavior.
   - In a later maintenance-required contract migration, remove `tags.category`, `tags_canonical_category_idx`, `TagCategory`, source category maps, SQL category selections/defaults, UI labels, tests, and documentation. Do not combine this rebuild with initial automation deployment.

3. **Separate raw hints, deterministic projection, and automated effective state**
   - Replace `ensureStoredTags()` as the central lifecycle mechanism with services for: parse raw hints, exact-resolve against D1, persist novel standalone concepts/evidence, calculate effective assignments, and write audited changes.
   - Preserve original submission/admin hints independently from effective public assignments. Never overwrite evidence when automation corrects tags.
   - Ensure site create, first approval, reapproval, and material edits increment `content_version`, recalculate the canonical metadata hash, write deterministic exact mappings, create one idempotent job/outbox row in the same D1 transaction, and leave the public site usable.
   - Fix reapproval so changed submission hints create a new classification revision without overwriting later admin-authored site content.
   - Make orphan concept creation and site mutation atomic; remove the current possibility of unmapped tags surviving a failed site write.

4. **Implement encrypted, admin-managed provider configuration**
   - Add `TAXONOMY_MASTER_KEY_V1` as a required Worker secret; use HKDF-separated AES-GCM keys with authenticated context containing config ID/provider/key version. Store only version, nonce, ciphertext, and masked credential metadata in D1.
   - Decrypt credentials only inside provider calls. Never serialize them through server functions, logs, errors, audit JSON, queue messages, or browser query caches.
   - Support staged key rotation: add a newer master secret version, re-encrypt bounded config batches, verify, switch active version, retain old key during rollback, then remove it in a later explicit operation.
   - Add authenticated admin operations to create/test/disable provider configs. A test call validates endpoint, auth, model, timeout, and strict structured output without activating it.
   - OpenAI-compatible adapter supports configurable HTTPS base URL/model and explicit Responses or Chat Completions structured-output dialect. Gemini adapter uses its structured JSON schema endpoint. Normalize status, usage, latency, retryability, and parsed decision output behind `TaxonomyProvider`.
   - Enforce endpoint safety: HTTPS only, no credentials in URL, reject localhost/private/link-local destinations and redirects to them, bounded response size/time, fixed allowed headers, and no arbitrary request templates.

5. **Build durable dispatch and processing**
   - Add a custom TanStack server entry (`src/server.ts`) using `createServerEntry` and the default fetch handler, plus Cloudflare `queue` and `scheduled` handlers.
   - Configure a taxonomy producer/consumer Queue, DLQ, and cron trigger in `wrangler.jsonc`; generate equivalent isolated staging resources in `scripts/staging-config.mjs` and regenerate Worker types.
   - Use a transactional outbox because D1 and Queue cannot commit atomically. HTTP mutations commit job+outbox; best-effort immediate dispatch follows; cron sweeps undispatched rows, stale leases, retry-wait jobs, expired raw response retention, and deferred evidence reassessment.
   - Queue messages contain only `{jobId}`. Enforce a unique job key: site ID + input hash + taxonomy version + policy/provider-routing version.
   - Consumer conditionally leases one job, verifies current content/taxonomy/config versions, marks obsolete work, invokes configured providers, records each attempt, validates output, applies policy, and explicitly acknowledges/retries each message. Duplicate deliveries must be harmless.
   - Classify transient HTTP/provider/quota/D1 failures for exponential backoff with jitter. Schema violations get a small bounded retry count. Exhausted jobs enter a durable terminal/degraded state and conservative resolution; DLQ/cron reconciliation recreates missing processing state rather than relying on queue retention.
   - Enforce D1-backed daily request/token budgets before provider calls. Budget exhaustion defers jobs without blocking public behavior.

6. **Automate assignments and ontology publication safely**
   - Site classification operates on a bounded snapshot of relevant canonical concepts (exact matches plus SQL-selected lexical/co-occurrence candidates); do not load the complete graph for every job. Add embeddings only if measured catalog growth requires retrieval; keep this out of the initial implementation.
   - Existing-tag assignment decisions can add/remove/replace effective tags when policy passes and no lock conflicts. Raw hints and before/after assignment sets remain in audit records.
   - Novel concepts accumulate evidence keyed by normalized concept and distinct site/input hash. At threshold, providers evaluate whether to create, alias, or merge; deterministic policy validates collisions and support.
   - Ontology publication runs in one guarded D1 transaction against an expected taxonomy version. Re-read all aliases, involved tags, locks, evidence, and graph constraints at apply time; increment taxonomy version only after success.
   - Autonomous aliases/merges/new tags/parent changes require configured provider agreement (default consensus), evidence threshold, and stricter confidence than assignments. Never force a low-confidence best guess.
   - Apply bounded hierarchy limits and reject orphaning/over-broad restructures. Merges become reversible: retain source concept/tombstone and mapping provenance rather than destructive deletion.
   - After ontology publication, enqueue only affected sites/concepts using bounded keyset scans; do not reclassify the entire catalog synchronously.

7. **Add audit, locks, rollback, and circuit breakers**
   - Every deterministic/AI/admin/migration action writes append-only actor, provider/model/config/prompt/schema versions, input hash, taxonomy version, scores, short sanitized evidence, before/after JSON, release SHA, and batch ID.
   - Store full provider payloads only in attempts with configurable short retention; retain structured decisions, usage, hashes, and redacted evidence long term.
   - Manual admin corrections create locks by default. Automation may record conflicting suggestions but cannot apply them until unlock.
   - Rollback one event, one site classification, or a batch by validating current revisions and writing compensating operations. If later dependent changes exist, produce a bounded dependency plan and refuse unsafe partial rollback rather than silently corrupting the graph.
   - Circuit breaker monitors provider schema failure, provider disagreement, rollback rate, mutation volume, budget anomalies, and configured quality metrics. Trip atomically to `degraded/shadow`, preserve deterministic mappings, and stop autonomous writes while jobs continue to collect evidence or defer.

8. **Replace manual taxonomy admin with automation operations**
   - Remove routine “Map/Make canonical/Merge” as the primary workflow. Keep advanced audited correction tools because user-selected rollback and locks require them.
   - Add admin panels with bounded server pagination for:
     - Automation status, queue/outbox/job health, degraded reason, and current taxonomy revision.
     - Provider credentials/configuration/test status and routing policy.
     - Full safe policy controls, immutable config revisions, shadow/gradual/autonomous mode, rollout percentage, budgets, hierarchy limits, and retry settings.
     - Shadow evaluation and provider disagreement samples.
     - Recent automated mutations, sanitized evidence, locks, event/site/batch rollback.
     - Dead/settled jobs and manual retry controls.
   - Never expose API keys after submission; show provider/model/endpoint and masked key fingerprint only.
   - Remove every tag-category field, filter, label, type, copy string, and count from public/admin UI.

9. **Mandatory shadow calibration and migration rollout**
   - Deployment 1: additive schema, provider/config UI, queue/cron code, deterministic job creation, and shadow-only processing. Public effective tags stay unchanged.
   - Backfill all active sites with keyset-paginated jobs using the preserved taxonomy revision. Run both configured providers according to admin routing and gather structured decisions/disagreements.
   - Build an automated evaluation report against preserved assignments plus deterministic invariants. Require configurable minimum coverage, schema success, provider agreement, bounded proposed mutation volume, and a reviewed gold-fixture CI suite before gradual mode can activate. The gate must block activation, not merely warn.
   - Gradual rollout applies site assignments first by stable site hash percentage. Ontology publication remains shadow until its stricter consensus/evidence gate passes.
   - Increase rollout automatically only while circuit-breaker metrics remain healthy; otherwise stop and revert the current automation batch where policy requires.
   - Once stable, enable autonomous ontology changes, then run the category-removal contract migration in a separate maintenance release.
   - Preserve the old taxonomy/config/audit data through the rollback interval; do not use D1 Time Travel as routine rollback.

10. **Provisioning and release safety**

- Add a non-destructive provisioning/preflight script that checks required production/staging Queue, DLQ, cron, master-secret versions, D1 bindings, and provider readiness. Creation commands run only after explicit user approval.
- Extend `scripts/check-release.mjs`, `scripts/release.mjs`, smoke tests, staging config, `.dev.vars.example`, CI, and strict dry-run checks for custom entry handlers and isolated queue names.
- Release must back up D1 before migration, verify queue resources before promoting code that emits outbox work, keep automation disabled/shadow if providers are absent, and never make public reads depend on provider availability.

## Validation

- Pure unit tests: normalization, hashes/job keys, provider response adapters, strict schema rejection, endpoint SSRF guards, encryption/decryption/rotation, policy thresholds, evidence aggregation, hierarchy bounds, locks, and compensating rollback generation.
- D1 integration tests against migration replay: seed revision import, alias/slug uniqueness, canonical-only parents, cycles/depth/fan-out, atomic site+job+outbox writes, duplicate queue delivery, concurrent leases, obsolete inputs, taxonomy-version races, atomic assignments, reversible merges, lock enforcement, rollback dependencies, and category-column removal.
- Provider fixture tests: OpenAI Responses, OpenAI Chat Completions, Gemini structured output, hallucinated IDs, extra prose, malformed/truncated JSON, prompt injection in metadata, timeout, 429/5xx, auth failure, failover, consensus disagreement, and budget exhaustion. Normal CI must not call live providers.
- Queue/cron tests: local custom handler invocation, per-message ack/retry, outbox recovery, stale lease recovery, DLQ reconciliation, conservative terminal settlement, and no work without active config.
- UI tests: encrypted provider create/test/rotate, safe config revisions, shadow gate, gradual controls, job health, locks, event/site/batch rollback, category-reference absence, and accessibility.
- Evaluation fixtures include positive/negative examples per existing tag, ambiguous sites, sparse metadata, malicious hints, novel rare concepts, repeated novel concepts, near-synonyms, and parent/child distinctions. Gate autonomous mode on high precision and mutation-volume limits.
- Full project gate: format, lint, TypeScript, Worker type generation, unit/integration tests, nine-plus migration clean replay, Drizzle generation drift, build, strict production/staging dry-runs, and smoke tests with AI disabled, provider failure, shadow mode, gradual mode, and rollback.

## Operational Failure Semantics

- Provider/queue/cron outages never block site publication or public browsing.
- Exact D1 resolution remains available; failed automation retains current/normalized tags and retries or settles conservatively.
- No model output writes directly to taxonomy tables; all writes pass strict schema, policy, expected-version, lock, collision, graph, evidence, budget, and circuit-breaker checks.
- D1 is sufficient to reconstruct pending work, audit history, effective assignments, and rollback state. Queue messages, decrypted credentials, and provider raw output are never the sole source of truth.

## Explicitly Out Of Scope

- Crawling or rendering submitted websites.
- Vectorize/embeddings until measured taxonomy size or evaluation demonstrates need.
- Cloudflare Workflows; Queue + D1 state + cron is sufficient.
- Remote resource creation, migration, or deployment without separate explicit approval.
