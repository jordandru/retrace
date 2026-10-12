# Sentry cron monitoring for the Worker's scheduled jobs (design note v1)

**Status:** v1, 2026-10-12, by claude-code (the "system optimization" pane, `claude-opus-5-5`, model source harness-runtime), on Jordan's
instruction `evt_8e43e1842df64d5580fd67d0135349ed` ("… and write the Sentry cron-monitoring design note."), dispatched by the coordinator's
pointer `evt_a9e30fbef4644ae383aa0a0da0f482d8` (receipt `evt_4120fdf6dbfc41558ddac7d375204040`; its Sentry findings
`evt_77470f7e966a41af8aa81ee78b805cb1`). Class **(a)** under agent-rules 12 (`docs/agent-rules.md:145-160`): it governs a later code change.
**It proposes no code in this PR**, opens no Sentry account, holds no DSN, installs no package and sends nothing to Sentry.

Every claim is sourced: `file:line` at `3201e918`, a GitHub issue of this repository, or a documentation page read on 2026-10-12 (§10 lists
them with their short names, S1-S6, C1-C6, H1-H2). Nothing here was run against Sentry, Cloudflare's API or Healthchecks.io.

## 1. The problem: three jobs whose failures reach only the console

The Worker `retrace-api` has two cron triggers, `7 * * * *` and `*/5 * * * *` (`apps/worker/wrangler.toml:48-49`), which Cloudflare runs on
UTC (C1: "Cron Triggers execute on UTC time."). Both call one handler, `scheduled` (`apps/worker/src/index.ts:96`).

| Job | When | What it does | How it fails today |
|---|---|---|---|
| Pending drain | every invocation of either trigger (`index.ts:100-105`), so 12 `*/5` runs and the `:07` run each hour | `drainPendingGithubDeliveries` lists up to 20 drainable webhook deliveries (`packages/core/src/router.ts:1233`), leases each for 60 s (`router.ts:1236-1242`; `PENDING_LEASE_MS`, `packages/core/src/classify.ts:53`), seals what it can and returns `{ drained, failed }` (`router.ts:1365`) | A thrown error is caught and written with `console.error("pending drain failed: …")` (`index.ts:103`). A malformed payload (`router.ts:1244-1250`), a lease that could not be saved (`router.ts:1356-1359`) and a delivery not yet fully sealed (`router.ts:1363`) only raise `failed`, which is written with `console.log` (`index.ts:102`). |
| Hourly checkpoint | the `:07` run only; a `*/5` run returns after starting the drain (`index.ts:106`) | `runCheckpointCron` checkpoints each opted-in project whose head moved or whose last checkpoint is not yet witnessed (`packages/core/src/checkpoint-cron.ts:187-196`), witnesses it in Rekor and saves the row (`checkpoint-cron.ts:200-208`) | A Rekor failure is caught: the row is saved with `witness_error` and the result says `witness: "failed: …"` (`checkpoint-cron.ts:204-209`), written with `console.log` (`index.ts:123`). A thrown error goes to `console.error` (`index.ts:124`). With no signing key the hourly pass returns before both hourly jobs and writes nothing at all (`index.ts:112-113`). An empty opt-in list writes one skip line (`index.ts:108-110`). A malformed list throws before either hourly job starts (`checkpoint-cron.ts:161-168`, called at `index.ts:107`), and so does a malformed `RETRACE_CREDENTIALS`, which is fail-loud by design (`index.ts:51-52`, thrown from `index.ts:116`). |
| Export-cache refresh | the `:07` run, chained after the checkpoint in the same `waitUntil` (`index.ts:126-136`) | `refreshExportCache` rebuilds the cached bundle of each project whose head moved (`packages/core/src/export-cache.ts:111-151`); `recordExportCacheRefreshResults` stores the outcome in D1 `export_cache_refresh` (`apps/worker/src/export-cache-refresh.ts:16-43`) | A per-project error is caught as `action: "failed"` (`export-cache.ts:146-147`) and written with `console.log` (`index.ts:134`). A failed status write is caught and written with `console.error` (`export-cache-refresh.ts:44-48`). Only an error outside both reaches `console.error("export cache refresh failed: …")` (`index.ts:135`). |

**Why Cloudflare records these failures as successes.** C2: "The first `ctx.waitUntil` to fail will be observed and recorded as the
status in the Cron Trigger Past Events table. Otherwise, it will be reported as a success." Each of the handler's `waitUntil` chains ends in
a rejection handler (`index.ts:103`, `index.ts:124`, `index.ts:135`), so none of them fails, whatever the jobs did. Only the two throws that
happen before those chains (`index.ts:107`, `index.ts:116`) reject the handler itself, and C2 does not say how that is recorded. Issue #132
is the measured case. From 2026-09-24T18:07:55Z every hourly refresh threw `D1_ERROR: Serialized RPC arguments or return values are limited to
32MiB …`, `refreshExportCache` caught it as `failed`, and the `wrangler tail` of the 18:07Z run on 09-27 showed invocation outcome `ok`.
In the issue's words, "the console line was the only trace".

What exists today is read on demand: Workers Logs keep the console lines (`wrangler.toml:51-55`); Cloudflare's Cron Events "stores the 100
most recent invocations" (C1); `doctor` reads `/status` and warns when the export cache has been stale for more than 7,200 s or its last
refresh failed (`packages/mcp-server/src/doctor.ts:898-910`, read at `doctor.ts:978-982`). Nothing reports the checkpoint or the drain, and
nothing sends an alert when nobody is looking.

## 2. The design: HTTP check-ins from the scheduled handler, no SDK

Sentry Crons takes check-ins over plain HTTPS at `https://o<orgId>.ingest.sentry.io/api/<project-id>/cron/<monitor_slug>/<public-key>/`,
with `?status=in_progress`, `ok` or `error`, and a `check_in_id` that pairs a run's start with its end (S1). No SDK is needed: a monitored
run sends two `fetch` requests.

**Monitors: one to start, `retrace-api-hourly`, for the `:07` invocation.** It reports `ok` only when, in that invocation, all of these
hold: the drain did not throw; `runCheckpointCron` resolved and no result's `witness` begins with `failed:`; `refreshExportCache` resolved
with no `failed` result; and the refresh's status writes succeeded (today they are only logged, `export-cache-refresh.ts:44-48`; the code PR
makes them visible to the check-in). Everything else reports `error`. That includes the hourly pass returning early for want of a signing
key, or on an opt-in list that is empty or does not parse (§1): no checkpoint was made. If the handler throws before the jobs (§1), the
terminal check-in still reports `error`; if even that is lost, the open `in_progress` becomes a timeout at `max_runtime` (S2), which also
alerts. The empty list is a configured state (`wrangler.toml:27-29`), but a monitor exists only while checkpoints are expected. Why one
monitor and not one per job:
- the free plan includes one (§5);
- the checkpoint and the refresh run in one invocation and one `waitUntil` chain, so one pair of check-ins covers both;
- the same invocation also runs the drain.

The twelve `*/5` drain runs are not monitored in this plan. A second monitor, `retrace-api-drain`, would cover them (Decision 2).

The drain's `failed` count is not mapped to `error`. It counts deliveries left pending for the next run as well as terminal ones: a deadline
(`router.ts:1298`) or a classification that reached no decision (`router.ts:1317`, `router.ts:1340`) keeps a delivery pending, and the next
run retries it. A positive count is therefore ordinary webhook latency, not a broken job (Decision 6).

**Order inside one monitored invocation.**
1. At the start, `in_progress` with a fresh `check_in_id` (a random UUID), registered with `ctx.waitUntil` and not awaited: the jobs start
   when they start today.
2. The jobs run unchanged.
3. Once every job has settled *and* the `in_progress` request has settled, the terminal check-in (`ok` or `error`) is registered with
   `ctx.waitUntil`. Waiting for the first request keeps the two in order. If `in_progress` did not succeed, the terminal check-in is sent
   without a `check_in_id`. S1 documents that form as a heartbeat ("Heartbeat monitoring notifies Sentry of a job's status through one
   check-in."); a terminal check-in carrying an id Sentry never saw is not described on the pages read.

**A check-in never fails or delays a job.** Nothing in a job waits on a check-in, and each check-in is abandoned after 2 seconds. Its
promise catches every error and never rejects, because a rejected `waitUntil` would turn Cloudflare's own record of the run into a failure
(C2), blaming the job for a monitoring fault. On failure it writes one fixed line: the monitor slug, the status it tried to send, and the
kind of failure (`timeout`, `network` or `http <code>`). The line never includes the URL, which carries the key, never `e.message`, since a
`fetch` error may repeat the URL, and never a response body. Issue #232 is the precedent for this rule: an error message that repeats its
input can put the start of a secret into Workers Logs (`index.ts:61`). The limits leave room. The account is on Workers Paid
(`wrangler.toml:51`). A scheduled invocation has at most 15 minutes of wall time ("Scheduled Workers have a maximum wall time of 15 minutes
per invocation"); Paid allows 30 seconds of CPU for schedules under an hour, 15 minutes for hourly or longer ones, and 10,000 subrequests
per invocation (C3). Two check-ins add two subrequests.

**Schedule and margins of `retrace-api-hourly`** (where they are set is Decision 4):
- schedule: crontab `7 * * * *`, timezone UTC (C1);
- `checkin_margin`: 5 minutes. This is "Allowed margin in minutes after the expected check-in time before the monitor is considered missed"
  (S2), so a run that never starts is reported by :12;
- `max_runtime`: 15 minutes. This is "Allowed duration in minutes that a monitor may be in_progress before being considered failed due to
  timeout" (S2); 15 minutes is the wall-time limit of the invocation itself (C3), so an `in_progress` still open at :22 means the run was
  cut off;
- `failure_issue_threshold` 1 and `recovery_threshold` 1 (S2; Decision 3).

With a second monitor, `retrace-api-drain` would take crontab `*/5 * * * *`, `checkin_margin` 2 and `max_runtime` 5. It would receive
check-ins only from the `*/5` invocations; the `:07` run's drain stays inside `retrace-api-hourly`. Two check-ins every five minutes are far
inside Sentry's limit of "6 per minute for each monitor environment" (S1).

## 3. Exactly what leaves the Worker

Per check-in, one HTTPS `GET` to Sentry's ingest host:
- **host** `o<orgId>.ingest.sentry.io`, which names the Sentry organisation;
- **path**: the Sentry project id, the monitor slug and the public key. The slug names the Worker (`retrace-api`, `wrangler.toml:1`), not a
  ledger project;
- **query**: `status`, and `check_in_id` when the pair is used: a random UUID, derived from nothing in the ledger. **Not sent:**
  - `environment` (S1: "If you don't specify an environment with your check-ins the default is `production`.");
  - a duration (S2: "Sentry uses the time between the in_progress and terminal (ok/error) check-ins to compute duration."; S1 documents no
    duration parameter);
  - `monitor_config`, if Decision 4 keeps the configuration in Sentry;
- **headers**: what the runtime sends with a bare `fetch`, plus Cloudflare's `CF-Worker` header, which "is set to the name of the zone which
  owns the Worker making the subrequest" (C4). C4 does not say what value a `workers.dev` Worker sends; the first check-in shows it;
- **timing**: when each request arrives.

Nothing else leaves: no event, id, hash, count or project name from the ledger, no request data, no error text, no job result. Results stay
in Workers Logs (`index.ts:102`, `index.ts:123`, `index.ts:134`) and in D1 (`checkpoint-cron.ts:208`, `export-cache-refresh.ts:23-43`).

**The key.** One Worker secret, `RETRACE_SENTRY_CRONS_DSN`, holds the DSN of a Sentry project used for nothing else. The check-in URL is
built from it. Jordan sets it with `wrangler secret put`, outside every agent pane (agent-rules 13). When it is unset, no check-in is sent:
that is the off switch (§8).

**What a leaked key exposes.** It reads nothing. S4: DSNs "only allow submission of new events and related event data" and "do not allow
read access to any information"; the risk is that "any user can send events to your organization with any information they want". So a
leaked key lets anyone do two things:
1. Forge check-ins. An `ok` sent on schedule would hide a missed or failed run, which is the harm that matters here.
2. Submit other event types to that Sentry project.

It is not limited to check-ins: the key belongs to the project, not to the monitor. Containment:
- a Sentry project with nothing else in it;
- revoke and rotate the key in the project's Client Keys settings (S4).

Per-key rate limits exist only on Business and Enterprise and limit error events (S6), so they are no part of this. Sentry calls a DSN safe to
publish, but the Worker still keeps it as a secret, because the harm is a forged `ok`, not a read.

## 4. Fail-closed, and observability is not evidence

- **What alerts.** S3: missed means "The job didn't execute in the predicted timeframe or frequency." Timeout means "A timeout failure event
  when a job sent an initial check-in but failed to send a final check-in." Failed means "The job has reported its execution as
  unsuccessful." "Issues are created when a cron monitor job execution is missed or failed", and "Monitor owners also receive notifications
  when a monitor becomes broken". With `failure_issue_threshold` 1 the first such run alerts.
- **Fail-closed both ways.** The Worker never depends on Sentry: nothing waits for a check-in, a check-in is abandoned after 2 s, and it never
  rejects (§2). Sentry's silence is never read as health: a run Sentry never hears about becomes a missed check-in, and that alerts.
- **What it cannot see:**
  - a run whose jobs report success while doing the wrong thing;
  - a forged `ok` (§3);
  - anything that happens while Sentry itself is not receiving check-ins (§11).
- **Pausing.** S3: "When you pause, your monitor will stop recording check-ins and will no longer notify you of any failed or missed
  check-ins." It "won't pause the execution of your job".
- **Observability, not evidence.** A check-in is Sentry's note that a request arrived carrying a status. It is not signed with a producer key,
  not in the ledger's hash chain and not witnessed in Rekor. Retrace never treats it as a seal. It never writes one into the ledger as a
  record that roots or attests anything, and never cites one as proof that a checkpoint exists. A checkpoint's evidence is its saved row and
  its Rekor entry (`checkpoint-cron.ts:200-208`). A Sentry `ok` means "the Worker said so", which is a console line with an alert attached.

## 5. Cost

From the Sentry pricing page (S5, read 2026-10-12):

| Plan | Price | Cron monitors |
|---|---|---|
| Developer | $0; "Limited to one user" | 1 |
| Team | $26/mo | 1, "+$0.78/monitor additional" |
| Business | $80/mo | 1, "+$0.78/monitor additional" |

The page does not say over what period the $0.78 is charged.

- **Cheapest option covering the hourly checkpoint:** one monitor, `retrace-api-hourly`, on Developer, at $0. It also covers the export-cache
  refresh, and the drain once an hour.
- **Adding the `*/5` drain** as a second monitor: Team, $26 plus $0.78.
- **Separate checkpoint and refresh monitors** (three in all): $26 plus 2 × $0.78. These would need separate check-in pairs inside one
  invocation.
- S3: "Unlike pausing, muting does not stop billing."

## 6. Alternatives

**(a) Cloudflare, natively.** Measured from Cloudflare's pages on 2026-10-12:
- Cron Events keeps the last 100 invocations, Workers Logs keeps the invocation logs longer, and the GraphQL Analytics API serves cron
  events (C1).
- The status those records carry is set by the first rejected `waitUntil` (C2). None rejects here (§1), so every run reads as a success,
  apart from the two throws before the chains whose recording C2 does not describe; #132's tail showed `ok`.
- The available-alerts page lists no Workers or cron notification. "Custom Alerts (Beta)" "evaluate a SQL API query on a schedule", and the
  page does not say whether any Workers dataset is included (C5).

So Cloudflare offers a record but no push alert for this. Making it serve would need two changes. First, a job failure would have to reject a
`waitUntil`; Cloudflare's pages read do not say whether a failed scheduled event is retried (C1, C2), so this is not proposed without a
measurement (Decision 8). Second, something outside Cloudflare would have to poll the GraphQL API and alert, which is a health-check service
built by hand. **Why not, for now:** there is no documented alert path.

**(b) A healthchecks-style service.**
- Healthchecks.io's free Hobbyist plan is $0 a month to "Monitor 20 jobs", with "100 log entries per job"; Supporter is $5 a month (H1).
- It has the same model: a `/start` ping, a success ping, a `/fail` ping, and a run id (`rid`) that pairs start with finish to "calculate an
  accurate duration" (H2). The data leaving is the same.

**Why it may be better:** it monitors the hourly run and the drain separately, and the checkpoint and refresh apart if wanted, for $0, where
Sentry needs Team from the second monitor. **Why it is not the design here:** Jordan's task names Sentry, and Sentry would be one vendor for
this and for any later error capture (§7). Decision 1.

**(c) Retrace's own data.**
- `/status` already carries `export_cache` (`packages/core/src/status.ts:143`), and `doctor` already warns on it (§1).
- There is no checkpoint field. The `checkpoints` table is written by the cron and read only by `latest()`
  (`apps/worker/src/checkpoint-log.ts:8-17`).

A checkpoint field could be added, but age alone is not failure. A run writes a checkpoint only when the head moved or the last checkpoint
is not yet witnessed (`checkpoint-cron.ts:191-195`), so the field must carry the head beside it: the head moved, and there has been no
witnessed checkpoint for longer than N. **Why not alone:** it is pull. It warns only when someone runs `doctor` or CI runs the gate on a
pull request, and it cannot tell that an invocation never happened until someone looks. **Why keep it:** no third party is involved and
nothing leaves. It also checks the outcome (is the cache fresh, is the head witnessed) where a check-in checks the run. It is recommended as
a complement (Decision 7).

## 7. Out of scope

- Sentry error capture and tracing in the Worker (`@sentry/cloudflare` and its `withSentry` wrapper, coordinator findings
  `evt_77470f7e…`). They would send request data and error text, which §3 excludes; that would be a separate note with its own scrubbing
  rules.
- The published CLI and MCP server (`@retrace-dev/cli`, `@retrace-dev/core`). They run on users' machines, and nothing here reports from them.
- Seer.
- Retrace data in Sentry beyond §3, and Sentry data in the ledger.
- Issue #232's fix, which is its own pull request (§8), and any change to how the jobs themselves handle failure.

## 8. Rollout and rollback

**Rollout**
1. This note merges. Class (a) takes the design gate (`docs/team-roles.md:92-96`); routing is the coordinator's.
2. Issue #232's fix lands first. It is the same file and the same logging rule.
3. Jordan creates the Sentry organisation, a project used only for these monitors, and the monitor (§2's values; Decision 4). The DSN stays
   off every agent pane.
4. The code pull request follows, class (c) in surface S: the Worker's `index.ts` and a secret are both on surface S's list
   (`docs/design/effort-model-routing.md:54`).
   - **Scope.** A small module (for example `apps/worker/src/cron-checkin.ts`) holds the URL builder, the status mapping of §2, and the
     2-second never-reject wrapper; `index.ts` wires it in.
   - **Tests:**
     - an endpoint that never answers neither delays nor fails a job;
     - a failing check-in never rejects a `waitUntil`;
     - each failure shape of §1 maps to `error`;
     - the logged line contains no URL, key or message;
     - with the secret unset, no `fetch` is made.
   - **Review:** the code order (`docs/team-roles.md:92`), first pass at high effort for surface S (`effort-model-routing.md:54`); routing
     is the coordinator's.
5. Jordan sets the secret and deploys. The first `:07` run shows one paired check-in, and the `CF-Worker` value it carried is recorded (§3).

**Rollback.** Each step is independent of the others.
- **Stop sending:** `wrangler secret delete RETRACE_SENTRY_CRONS_DSN`. C6: "`wrangler secret delete` creates a new version of the Worker and
  deploys it immediately". With no secret, the code sends nothing.
- **Stop alerts but keep receiving:** pause the monitor in Sentry (S3, §4).
- **Remove the code:** revert the pull request and deploy. The jobs behave the same with or without it.

## 9. Decisions for Jordan

1. Use Sentry Crons as designed here; Healthchecks.io, which is free for every job separately (§6 b); or Retrace's own `/status` and `doctor`
   only (§6 c).
2. One free monitor for the hourly run now (recommended), or Team ($26/mo, plus $0.78 per extra monitor) for a drain monitor or separate
   checkpoint and refresh monitors.
3. `failure_issue_threshold` 1, so every missed, timed-out or failed hourly run alerts (recommended); or 2, which absorbs one transient
   Rekor failure and alerts an hour later.
4. Where the monitor's configuration lives:
   - set once in Sentry's interface (recommended), so only the status leaves the Worker;
   - or upserted from code, where `monitor_config` travels with check-ins (S1) and the schedule lives in this repository.
5. Accept that Developer is "Limited to one user" (S5): Jordan alone owns the monitor and receives its notifications (S3). Anyone else
   needs a paid plan.
6. Keep the drain's `failed` count out of the check-in status (recommended, §2), or map a run of consecutive failures to `error`.
7. Add a checkpoint field to `/status` and a `doctor` warning as a Retrace-native complement (§6 c): the head moved and there has been no
   witnessed checkpoint for more than 2 hours. That would be a separate class (c) pull request.
8. Measure what Cloudflare does with a scheduled event whose `waitUntil` rejects (retries or not) before any change that would let Cron Events
   show failures (§6 a).

## 10. Sources (all read 2026-10-12)

- S1 Sentry, Crons over HTTP: https://docs.sentry.io/product/crons/getting-started/http/
- S2 Sentry, check-in protocol (SDK developer docs): https://develop.sentry.dev/sdk/telemetry/check-ins/
- S3 Sentry, Crons job monitoring: https://docs.sentry.io/product/monitors-and-alerts/monitors/crons/job-monitoring.md
- S4 Sentry, DSN explainer: https://docs.sentry.io/concepts/key-terms/dsn-explainer/
- S5 Sentry, pricing: https://sentry.io/pricing/
- S6 Sentry, managing the event stream (rate limits per key): https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/
- C1 Cloudflare, Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- C2 Cloudflare, scheduled handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- C3 Cloudflare, Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- C4 Cloudflare, HTTP request headers (`CF-Worker`): https://developers.cloudflare.com/fundamentals/reference/http-headers/
- C5 Cloudflare, available notifications: https://developers.cloudflare.com/notifications/notification-available/
- C6 Cloudflare, Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- H1 Healthchecks.io, pricing: https://healthchecks.io/pricing/
- H2 Healthchecks.io, HTTP API: https://healthchecks.io/docs/http_api/

## 11. Measured, sourced, and not known

- **Measured** from this repository at `3201e918`: everything in §1, the status mapping's inputs in §2, and §6 c. From issue #132: the
  wedge, the caught `failed`, and the tail's invocation outcome `ok`.
- **Sourced** from the pages in §10: every statement about Sentry, Cloudflare and Healthchecks.io.
- **Not known**, to be measured on the first deploy or left open:
  - how Sentry records a terminal check-in whose `check_in_id` it never saw (§2 avoids sending one);
  - the `CF-Worker` value for this `workers.dev` Worker;
  - whether Cloudflare retries a scheduled event whose `waitUntil` rejects;
  - Sentry's own availability, and how long it takes to raise a missed check-in beyond the configured margin.
