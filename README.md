# Retrace

Provenance ledger for mixed human + AI work. Every event records **who** (person or agent) did **what**, **when**, **where**, **why**, and **how** — sealed in a tamper-evident hash chain, with causal links from each agent action back to the human instruction that triggered it.

```
packages/core        schema (zod), hash chain, verify, "why" chain, renderers   — runs in Node, Workers, browsers
packages/mcp-server  MCP server (stdio) + `retrace-serve` local UI/API server
packages/core/ui     timeline UI (single self-contained HTML, embedded into core at build)
apps/worker          Cloudflare Worker + D1 — REST API + serves the same UI at /
```

## Quick start (local, no cloud needed)

Walkthrough (clone → MCP → Worker → GitHub/Drive): [SETUP-GUIDE.md](SETUP-GUIDE.md). Published CLI: `npx @retrace-dev/cli` (`@retrace-dev/core` is the library).

```bash
npm install
npm run build
npm test
```

Add the MCP server to Claude Code (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "retrace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/retrace/packages/mcp-server/dist/index.js"],
      "env": {
        "RETRACE_PROJECT": "retrace",
        "RETRACE_ACTOR": "claude-code",
        "RETRACE_ON_BEHALF_OF": "<your email>"
      }
    }
  }
}
```

Leave `RETRACE_ACTOR_MODEL` unset so the agent reports the model it actually ran. This repo’s project is `retrace` (see `.retrace.json`); Boxing-RPG is a separate demo project.

Same block works in Claude Desktop's `claude_desktop_config.json`. Other harnesses keep the same `command` / `args` / `env` with their own actor and config file: Gemini CLI (`RETRACE_ACTOR=gemini`, `.gemini/settings.json`), Grok Build TUI (`grok`, `~/.grok/config.toml`), Codex (`codex`, plus `AGENTS.md`), GitHub Copilot CLI (`github-copilot`, `~/.copilot/mcp-config.json`), VS Code Copilot Chat (`github-copilot`, VS Code **user** MCP — `MCP: Open User Configuration`; do not commit `.vscode/mcp.json`), Cursor Agent (`cursor-agent`, `.cursor/mcp.json` with the token in `~/.retrace/cursor.env` via `envFile`). Each client needs its own pinned `RETRACE_TOKEN` — never Claude’s — or the Worker will seal events as the wrong actor. For the live Worker, add `RETRACE_URL` and that scoped token; locally, events go to `~/.retrace/retrace.db` (override with `RETRACE_DB`). `retrace-admin` still mints the original five harnesses only. GitHub.com Copilot coding agent cannot reach this checkout's stdio MCP.

### See the timeline

```bash
npm run serve            # → http://127.0.0.1:7777/?token=…  (one-time bootstrap; the UI stores then removes the token from the URL)
node scripts/seed-demo.mjs   # optional: seed a demo Boxing-RPG session first (RETRACE_DB=/tmp/demo.db to keep it separate)
```

The UI shows a per-project timeline (humans amber ●, agents blue ■, system grey), the chain-integrity badge, filters by actor type / action / artifact / text, and a detail panel with WHO · WHAT · WHEN · WHERE · WHY · HOW, the causal chain back to the originating instruction, downstream consequences, and hashes. It auto-refreshes every 15 s. Click any artifact chip or actor name to filter. ⚙ lets you point it at a remote Worker (URL + token) or load a JSON export offline. Tokens are kept in browser local storage per API endpoint and sent as bearer headers; a bootstrap `?token=…` is stored and immediately scrubbed from browser history. Deep link: `/?project=boxing-rpg&api=https://…` (enter the endpoint's token once under ⚙).

`retrace-serve` is **default-closed**: it binds `127.0.0.1` only and every read and write needs a token. With no `RETRACE_TOKEN` (and no `RETRACE_CREDENTIALS`) it generates a one-time token for that run and prints the URL with `?token=…`; the UI treats that query parameter as a one-time bootstrap, stores it for this API endpoint, and removes it from the address bar and browser history. Set `RETRACE_TOKEN` for a stable token. `RETRACE_HOST` widens the bind (e.g. `0.0.0.0` for a LAN demo) and still requires the token. `RETRACE_OPEN=1` restores the old unauthenticated server, on a loopback host only — combining it with a non-loopback `RETRACE_HOST` is refused at startup rather than served. `GET /api` (the schema probe) stays public.

### Git adapter — commits become events automatically

```bash
cd /path/to/your/repo
node /ABSOLUTE/PATH/retrace/packages/mcp-server/dist/git-hook.js install --project boxing-rpg
node /ABSOLUTE/PATH/retrace/packages/mcp-server/dist/git-hook.js backfill      # optional: log existing history (idempotent, safe to re-run)
npm exec --package=@retrace-dev/cli -- retrace doctor                         # read-only preflight; exits nonzero when capture is not ready
npm exec --package=@retrace-dev/cli -- retrace doctor --gate                  # CI: fail if HEAD is missing or an agent commit is not rooted in an instruction
npm exec --package=@retrace-dev/cli -- retrace status                         # human-readable integrity + capture + causality status
npm exec --package=@retrace-dev/cli -- retrace status retrace --json          # the identical canonical model for automation/agents
```

`install` writes `.git/hooks/post-commit` and a committable `.retrace.json` (`{ "project", "environment", optional "db" | "url" + "token" | "credential" }`). `"credential": "retrace-git"` makes the hook send that scoped assert credential's token (looked up by `actor.id` in `RETRACE_CREDENTIALS_FILE`, default `~/.retrace/worker-credentials.json`) instead of `RETRACE_TOKEN`, so the repo never carries the owner token; without it the precedence is unchanged (`RETRACE_HOOK_TOKEN` > `RETRACE_TOKEN` > file). Hook failures (a 401/403 from a fail-closed credential, config errors) are appended to `.git/retrace-hook.log` — re-log with `retrace-git commit <sha>`. Every commit is then logged: WHO = the author (human), or an **agent** when the commit carries trailers `Retrace-Actor: claude-code` / `Retrace-Model: …` or a `Co-Authored-By:` naming Claude/Copilot/Codex/Grok/etc. (the human author becomes `on_behalf_of`); WHAT = `commit:<repo>@<sha>` plus one `repo:<repo>#<path>` artifact per changed file with `+ins −del`; WHY = the commit message, and `caused_by` from a `Retrace-Caused-By: evt_…` trailer, `RETRACE_CAUSED_BY` env, or `.git/retrace-caused-by`. Merge commits log as `merged`. Idempotency key is the sha, so backfills never duplicate.

`retrace doctor` checks the repository marker and hook, resolves the scoped credential without printing its token,
confirms the actor on `HEAD` is authorized, compares the live Worker's schema with this build, verifies the project hash
chain, and confirms that `HEAD` reached the ledger. Every failure includes the command or configuration to repair it.
`retrace doctor --gate` is the same remote checks without local hook/credential-file wiring: missing HEAD is a failure,
and an agent-authored HEAD must walk `caused_by` to a human `instructed` event. Human commits are not required to
carry `Retrace-Caused-By` (omitting trailers still looks human). This repo runs it from `.github/workflows/retrace-gate.yml`
(`RETRACE_CI_TOKEN`). Ruleset **main gate** requires that check on `main`; repository admins are exempt so owner pushes
are not blocked.

**Remote-write guard.** Writing to a *remote* ledger needs a `.retrace.json` in the repo root — the committed marker
that says this repo logs somewhere. Without it, an ambient `RETRACE_URL` in your shell would silently make any scratch
repo write to production under a project named after its directory; that is how four junk projects reached the live
Worker on 2026-08-28. `retrace-git` now refuses, naming the ledger, the repo, the project it would have created, and
the ways out: `retrace-git install` (writes the file), `RETRACE_DB=<path>` to write locally, or `--allow-remote` /
`RETRACE_ALLOW_REMOTE=1` for env-only setups such as CI backfill. Local writes are not gated — a stray row in a SQLite
file is cheap to discard; a sealed event in a shared append-only ledger costs a `DELETE /projects/:p`.

Tip for agents (put in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `GROK.md` / `.cursor/rules/retrace-provenance.mdc`): *when committing, add trailers `Retrace-Actor: <your harness id>`, `Retrace-Model: <model>`, and `Retrace-Caused-By: <instruction event id>`.* Do not copy another harness's actor id.

### GitHub PR adapter — PRs, reviews, comments, CI runs become events

Point a GitHub webhook at `POST /hooks/github?project=<name>` (Worker or `retrace-serve`), secret = `RETRACE_GITHUB_SECRET`. Deliveries are HMAC-verified; each becomes an event: PR opened → `created`, new commits → `edited`, review → `approved` / `rejected`, comment → `sent`, merge → `merged` (with the merge commit as an artifact derived from the PR), Actions run → `executed` (system actor). Bots become `system` (Copilot/Claude-style bots become `agent`). Artifact ids line up with the git adapter (`pr:<owner/repo>#n`, `commit:<owner/repo>@<sha>`), and a `Retrace-Caused-By: evt_…` line in the PR body links the PR — and its reviews — back to the originating instruction. Redeliveries dedupe by delivery id.

```bash
node packages/mcp-server/dist/github-cli.js setup slcwitit/rpg --url https://retrace-api.<you>.workers.dev --project boxing-rpg   # prints webhook settings / gh api one-liner
node packages/mcp-server/dist/github-cli.js backfill slcwitit/rpg --project boxing-rpg --token $GITHUB_TOKEN                     # import existing PRs + reviews (idempotent)
node packages/mcp-server/dist/github-cli.js replay payload.json --event pull_request                                             # test with a saved payload
RETRACE_GITHUB_SECRET=hooksecret node scripts/simulate-github.mjs                                                                # fake a whole PR lifecycle against a local server
```

### Google Docs / Drive adapter — docs, sheets, slides, comments, sharing

Zero-infra path: paste `adapters/google-apps-script/Code.gs` into a new Apps Script project, enable the Drive Activity + People services, set `RETRACE_URL` / `RETRACE_TOKEN` / `RETRACE_PROJECT` (optional `RETRACE_FOLDER` to scope to one folder), run `setup`. It backfills the last 7 days and then polls every 5 minutes, forwarding Drive Activity to `POST /hooks/gdrive` where Retrace maps it: create → `created`, edit → `edited` (one event per co-editor, with the edit-session duration), comment → `sent`, share → `other:shared` (with who got what role), rename/move/trash/restore. Artifacts are `gdoc:<fileId>` (kind doc/sheet/slides/form/file), `gfolder:<id>`. Google doesn't expose comment text or Doc bytes via this API — only that an activity happened. Optional script property / payload field `RETRACE_CAUSED_BY` / `caused_by` attaches new events to the current instruct; empty = root. Full instructions in `adapters/google-apps-script/README.md` and SETUP-GUIDE Stage 7.

```bash
node packages/mcp-server/dist/gdrive-cli.js replay packages/core/test-fixtures/drive-activity.json --project boxing-rpg   # try the mapping locally
node packages/mcp-server/dist/gdrive-cli.js backfill --token "$(gcloud auth print-access-token)" --folder <id> --since 2026-08-01  # direct API backfill
```

### Prove — signed exports, printable reports, share links

Every export is a JSON bundle (events in scope + causal ancestors + full-chain verdict at export time) signed with an **Ed25519** key; the issuer's public key is embedded and also published at `/.well-known/retrace-pubkey`. Anyone can verify offline — but a signature is only **valid** against a key you trust. Verified against the key the bundle itself carries it is **self-attested** (anyone can re-sign an altered bundle with a fresh key), which `verify` reports as `NOT VALID` unless you pass `--allow-self-attested`. `verify` and `checkpoint` take the trusted key from `--pubkey <jwk.json|https-url>`, `RETRACE_PUBKEY`, or `RETRACE_URL`'s `/.well-known/retrace-pubkey` (https only; plain http is refused).

Verification checks four things and reports each: the **signature**, every event's **content hash**, the **prev_hash links** between adjacent events, and **coverage** — a hash chain only proves the events that are present were not altered, so for a full export (no `--artifact`/actor/time scope) `verify` also requires every claimed event to be present: exactly `chain.total_events` of them, contiguous `seq` from #0, ending at the claimed `head_hash`. A truncated tail, a dropped middle event, a duplicated event or a bundle with no head is `NOT VALID` with the missing seqs named. Scoped exports cannot be checked for omission offline; the verdict says so (`coverage: scoped`) instead of implying completeness. Bundles sealed after 2026-08-30 (`received_at` in the hash) need `retrace-export verify` from `@retrace-dev/cli` >= 0.1.2; 0.1.1 recomputes without `received_at` and reports every post-change event as a content hash mismatch. Events sealed with the `hash_v: 2` marker (inside the hash) have exactly one valid digest — a `received_at` edit, or stripping the marker to force the older rule, is tampering. Events without the marker are verified best-effort under either rule and counted (`legacy-hash events`) so a verifier sees how much of the ledger sits under the weaker check.

The head itself is still the issuer's claim at export time: an operator with database access can drop the newest events and re-export, and every hash still verifies. **Head checkpoints** close that: `retrace-export checkpoint <project>` takes a verified full export, records `{project, seq, head_hash, total_events, at, bundle_sha256}` signed with the local key, and appends it to `.retrace/checkpoints.jsonl` — **commit and push that file**; the pushed commit is the witness. `retrace-export verify <bundle> --checkpoint .retrace/checkpoints.jsonl` requires both a valid signature from the separately trusted checkpoint key and the checkpointed event at the same seq/hash (`EXTENDS` / `MATCHES`). The trusted key comes from `--checkpoint-pubkey`, `RETRACE_CHECKPOINT_PUBKEY`, or the committed `.retrace/checkpoint-public.jwk` fallback. A missing project checkpoint, unsigned/invalid checkpoint, untrusted signer, `PREDATES`, `UNVERIFIABLE`, or `CONFLICT` all make verification exit nonzero. `checkpoint` refuses to append if the ledger shrank since the last checkpoint.

This repo checkpoints its own ledger on a schedule: `.github/workflows/retrace-checkpoint.yml` runs daily (and on demand), takes a verified full export with the read-only `RETRACE_CI_TOKEN`, signs the checkpoint with a **separate** key held only in the `RETRACE_CHECKPOINT_KEY` secret (never the Worker's signing key), and opens a pull request. **Merging that PR is the witness** — a human decision, logged into the ledger by the GitHub webhook as `merged`, which is also what lets the merge commit through the gate. Mint the key once with `RETRACE_SIGNING_KEY_FILE=~/.retrace/checkpoint-key.json node packages/mcp-server/dist/export-cli.js keygen --print-private`, commit the printed public JWK as `.retrace/checkpoint-public.jwk`, and set only the private JWK with `gh secret set RETRACE_CHECKPOINT_KEY`; the repo must allow Actions to create pull requests. And the witness that is *not* you now exists: `retrace-export witness <project>` submits the newest signed checkpoint to the public **Rekor transparency log** (rekor.sigstore.dev) — Rekor verifies the checkpoint signer's Ed25519 signature over the checkpoint bytes, assigns an immutable log index, and returns a Signed Entry Timestamp; the record goes in `.retrace/witnesses.jsonl` (committed, with Rekor's public key as `.retrace/rekor-public.pem`), and `verify --checkpoint … --witnesses .retrace/witnesses.jsonl` then also requires the checkpointed head to be in Rekor, verifying the SET offline. Rewriting a witnessed head means rewriting a Merkle log you don't operate. The daily checkpoint workflow witnesses each new checkpoint automatically. The Worker also has an **hourly checkpoint cron** (`[triggers]` in wrangler.toml): only projects explicitly opted in through the `RETRACE_CHECKPOINT_PROJECTS` JSON array get a signed checkpoint published to Rekor and recorded in the D1 `checkpoints` table. Missing, blank, or `[]` publishes nothing; malformed configuration fails the run. This bounds rewrites for opted-in projects while the daily git PR remains the human-merged anchor. Apply the table once with `npm run migrate` (apps/worker) before deploying. Live since 2026-09-01 05:07 UTC: the first tick checkpointed three projects, and this repo's head #1170 is Rekor log index 2671809536 — checkpoint signed by the Worker's well-known key, SET verified offline against `.retrace/rekor-public.pem`.

**Reconciliation** (roadmap rung 4, `docs/reconciliation-plan.md`) checks the other direction: not "is the commit in the ledger" but "were the edits behind it logged, and by whom". `retrace-export reconcile [--since <ref>] [--limit N] [--gate]` takes the commit list from git (never from the ledger, so a commit the hook missed stays visible) and, for every file a commit changed, looks for agent edit events in that file's **capture window** — ledger events between the previous commit that touched the file and this one, ordered by server-assigned `seq`, so work that sat uncommitted for days still reconciles against the commit that finally carried it. Findings: `missing_commit` (fail — the only downgrade to warn is a commit that is the head of a pull request whose merge the server stamped `sealed_by: webhook:github`, a stamp no credentialed agent can produce; git author strings are never trusted), `misattributed` (fail when every file's only logged edits belong to another agent — the bfe87c3 shape, which this check finds from ledger data alone; warn per file when the story is partial), `uncovered` (warn by default — a silent producer; set `"reconcile": {"uncovered": "fail"}` in `.retrace.json` once a repo's producers are complete), `loose_match`, `orphan_edit`, `non_agent` (info). Coverage follows PROV: an explicit artifact role is authoritative (`generated`/`both` cover, `used` never does, even on an `edited` event); only a role-less ref falls back to the verb. A finding is acknowledged only by a `correction`-tagged event sealed *after* the commit's own seal, by a **human**, or by an agent that is explicitly listed in `"reconcile": {"ack_actors": [...]}` *and* does not share the accused seal's model or session — the accused committer never, and by default no agent at all (event #1227: the same grok-4.6 session, re-pinned as `cursor-agent`, acknowledged a `grok` commit; a different badge is not a different witness). Unsealed commits cannot be acknowledged at all, since a sha is computable before its commit exists. Remote exports are used only after `verifyExportBundle` passes against the trusted issuer key (`--pubkey`, `RETRACE_PUBKEY`, or the https well-known key) — a broken, unsigned, self-attested or incomplete export makes reconcile and the gate fail closed. `retrace doctor --gate` adds a **capture coverage** finding for HEAD — it fails on a commit only one producer sealed and never infers leniency from the local ref layout (a pull_request checkout is detached, with no remote-tracking branch containing HEAD); on a developer machine, unpushed work runs `doctor --gate --local`, an explicit flag the gate refuses under `GITHUB_ACTIONS`/`CI`. The daily checkpoint workflow reconciles everything since the previous checkpoint commit into the PR body. **Phase B — two producers for every commit.** With `RETRACE_GITHUB_PUSH=1` on the Worker and `push` among the repository webhook's events, GitHub's HMAC-verified push delivery seals each pushed commit a second time, under its own key (`gh:push:<repo>:<sha>`, never deduped against the hook's `git:<sha>`), resolving the actor from the pushed commit message with the same code the hook uses (`commit-actor.ts`). Reconcile then compares the two. **What counts as a seal is exact and server-issued**: the hook's event must carry the server stamp of *this repo's* hook credential (`.retrace.json` → `"reconcile": {"hook_sealed_by": ["assert:<credential name>"]}`) and the git adapter shape; nothing is trusted by credential class — a Drive or backfill assert credential, or a pinned agent, sending a perfect git-shaped `committed` event is a *claim* and is reported as one (`missing_commit`, with the stamp named). `owner` seals are an operator override, off unless `reconcile.owner_seals` is set, and never an independent witness; unstamped pre-2026-08-30 seals need `--allow-unstamped-seals`. A different actor from the two producers is `producer_disagreement` (fail); once both producers are active, an agent commit sealed by only one of them **fails** by default (`reconcile.dual_witness` / `--dual-witness warn` for unpushed local work) — that is precisely what an amend or rebase after the hook ran looks like, and the abandoned original shows up as `unreachable_seal`: the CLI checks every sealed sha for **ref reachability** (`git rev-list --all` — object existence is not the test, an amended original lingers as a loose object until gc), never treats history older than the checkout's oldest reachable seal as vanished (a shallow clone is unfetched history, not a rewrite), and excludes only the vanished seals from window boundaries; the gate checks out full history for the same reason. Legacy commit events sealed before the server stamped `sealed_by` bound windows but are never trusted as seals — an unstamped commit event *after* stamping began is a client claim and bounds nothing. A push-shaped event the server did not stamp `webhook:github` seals nothing. This is also what seals CI bot commits the hook can never see. Honest limits: a covering event proves an agent *claimed* the edit, not that the diff matches it (no per-file content hashes yet); human edits are outside the ledger by design. First run on this repo's last 120 commits: 119 sealed, 1 bot commit unsealed (its merge predates the webhook stamp, so it fails until the push webhook seals such commits), 3 complete mis-attributions (bfe87c3 acknowledged by #258; 1bc76c1 and 10bfcc9 open — the author's or a human's correction event is required, not the committer's), 215 uncovered files — mostly README/docs edits agents made without logging the file, which is exactly the nudge the warn is for.

If Rekor is unavailable, the signed checkpoint and error remain in D1 and the cron retries that unchanged head every hour. It becomes `unchanged` only after a witness succeeds; a transient outage cannot permanently strand the latest head unwitnessed.

```bash
node packages/mcp-server/dist/export-cli.js keygen                       # ~/.retrace/signing-key.json (auto-created on first export too)
node packages/mcp-server/dist/export-cli.js export boxing-rpg --artifact "repo:rpg#src/ui/JabCounter.tsx" --out jab.json --report jab.html
node packages/mcp-server/dist/export-cli.js verify jab.json              # VALID / NOT VALID + reasons (signature, hashes, links, coverage); --pubkey <jwk.json|https-url> (or RETRACE_PUBKEY / RETRACE_URL well-known) is the trusted key — without one the bundle is only self-attested
node packages/mcp-server/dist/export-cli.js share boxing-rpg --label "Jab counter — client review" --days 30
```

In the UI: **Report** opens the printable report (Print → Save as PDF), **Export** downloads the signed bundle, **Share** creates a read-only link (`/s/<id>`, optional artifact scope + expiry) that serves the timeline, chain verify, signed export and report **without a token**. Agents get the same via MCP tools `retrace_export` and `retrace_share`. Set `RETRACE_ISSUER="SLC WIT' IT"` to name the issuer; for the Worker put the private JWK in `wrangler secret put RETRACE_SIGNING_KEY` (print it with `keygen --print-private`) and set `RETRACE_PUBLIC_URL` if behind a custom domain.

### Lineage graph — which artifacts came from which

Toggle **Graph** in the UI (or `?view=graph`). Nodes are artifacts, laid out left→right by lineage depth; edges are **derived_from** (purple, explicit — e.g. commit → child commit, or `{derived_from: [...]}` on any artifact), **causal flow** (an event caused by another touched a different artifact: instruction → file → PR), and, with "show people & agents", dashed **touched** edges from actors. Click a node to highlight its neighbourhood and filter the timeline; artifacts with no links yet are packed in a grid below. Buttons export Graphviz DOT or copy Mermaid. API: `GET /projects/:p/lineage?artifact_id=&format=json|dot|mermaid&actors=1` (also `/s/:id/lineage`). MCP: `retrace_lineage`.

### Tools the agent gets

| tool | purpose |
|---|---|
| `retrace_instruct` | log a human instruction — the root of a causal chain; returns an id |
| `retrace_log` | log any action (created/edited/deleted/executed/approved/sent/…) with `caused_by` |
| `retrace_amend` | append a rooted correction for missing artifact roles or a historical causal attestation; sealed events are never rewritten |
| `retrace_history` | timeline, filter by artifact / actor / action / time / text |
| `retrace_why` | walk `caused_by` links back to the originating human intent |
| `retrace_verify` | recompute the hash chain and report integrity |
| `retrace_status` | integrity, causal coverage, capture gaps, actors and integration freshness |
| `retrace_export` | signed JSON bundle (+ optional HTML report file) for a project/artifact |
| `retrace_share` | create a read-only share link (project or artifact scope, optional expiry) |
| `retrace_lineage` | artifact lineage (text / DOT / Mermaid / JSON) |
| `retrace_projects` | list projects |

Suggested instruction to put in your project's `CLAUDE.md` so agents log automatically:

> At the start of each task call `retrace_instruct` with my request. After each file edit, command run, or decision, call `retrace_log` with `caused_by` set to the instruction id, a one-sentence `intent`, and the artifact ids you touched.

## Cloud mode (Cloudflare Worker + D1)

D1 database `retrace-db` (`ae8ebc52-9784-4109-b421-f63676972dfe`) already exists in your account with the schema applied.

```bash
cd apps/worker
npx wrangler login
npx wrangler secret put RETRACE_TOKEN     # pick a long random string (owner token: UI, DELETE, share)
                                          # set RETRACE_OWNER=<your email> under [vars] so owner-only actions (DELETE) are audited as you, not as "worker"
npx wrangler secret put RETRACE_CREDENTIALS   # optional: per-actor tokens, e.g. '[{"token":"<32+ chars>","actor":{"type":"agent","id":"claude-code","model":"claude-fable-5","on_behalf_of":"you@example.com"}}]'
                                          # pinned (default) tokens get their actor stamped by the Worker; add "trust":"assert" for the git hook / forwarders
npx wrangler deploy                        # prints https://retrace-api.<you>.workers.dev
```

The Worker refuses every request with `503` when neither `RETRACE_TOKEN` nor a non-empty `RETRACE_CREDENTIALS` array is configured. There is no implicit cloud open mode; configure at least one before deployment.

### Hosting teams on one Worker

`retrace-admin new-team <project> --member a@x.com,b@y.com [--harness claude-code,codex,gemini,grok,github-copilot]` provisions a paying team without touching their code: it mints **project-scoped** credentials (`Credential.projects = [<project>]`, so a leaked team token can read or write nothing else) — one pinned agent credential per member × harness (`on_behalf_of` = that member, so only their own instructions can be recorded as theirs), one assert credential for the team's git hook (`retrace-git-<project>`, `allowed_actors` = the team's agents and members) and one read-only CI credential — appends them to `~/.retrace/worker-credentials.json` (atomic, `0600`, refuses if the project already has a set), and writes `onboarding-<project>.md` (`0600`; it contains the tokens — send it like a password, then delete it). Nothing changes on the Worker until you run the printed `npx wrangler secret put RETRACE_CREDENTIALS < ~/.retrace/worker-credentials.json`. `retrace-admin list-teams` shows what the mirror holds. A project needs no creation step: it exists from its first event. Ceiling to know about: a Worker secret is limited to a few KB, i.e. tens of credentials — moving credentials into D1 is the next rung when that bites.

Then point the MCP server at it by adding to its `env`:

```json
"RETRACE_URL": "https://retrace-api.<you>.workers.dev",
"RETRACE_TOKEN": "<same token>"
```

REST API: `POST /events`, `GET /events/:id`, `GET /events/:id/why`, `GET /projects`, `GET /projects/:p/events?artifact_id=&actor_id=&since=&text=`, `GET /projects/:p/head`, `GET /projects/:p/verify`, `GET /projects/:p/status`.

### Where an event came from — session, terminal, IDE

`location` records more than a path. Six fields are **server-stamped**: `retrace_log` silently drops
`session`, `device`, `client`, `ide`, `workspace` and `surface` if a caller sends them, because they are evidence *about*
the writer and an agent that could assert them could forge the thing they exist to prove — the same reasoning, and the
same place of enforcement, as `RETRACE_ACTOR_LOCK` (both live in the MCP server; the Worker's `POST /events` trusts
whatever a scoped credential sends, as it always has). `path`, `url`, `environment` and `system` stay caller-wins: the
agent knows the file it edited better than the server, which only knows its own cwd.

| field | what it is | where it comes from |
|---|---|---|
| `session` | the harness session, shared across everything one agent run touches | `CLAUDE_CODE_SESSION_ID` or `GROK_SESSION_ID` (the harness passes it to MCP subprocesses and to shells, so the **git hook stamps the same value** and a commit joins that run's events). `RETRACE_SESSION` overrides; an MCP client with no session gets a `run_…` id. A human's own `git commit` gets **none** — no fallback, because an id that is always present cannot discriminate. Copilot CLI 1.0.82 was measured: it has no session env (`COPILOT_HOME` is not one), so its events use `run_…`. |
| `client` | which MCP client wrote it, `name@version` | the MCP `initialize` handshake — e.g. `claude-code@2.1.250`, `cursor-vscode@1.7.3`, `grok-shell-retrace@1.0.13` |
| `system` | the tool the event came from | the same handshake (`cursor-vscode` → `cursor`, `grok-shell-retrace` → `grok`, `copilot-cli` → `github-copilot`). It used to be hardcoded `claude-code` for every client. `RETRACE_SYSTEM` overrides, and unlike the six above a caller may still set it — an adapter legitimately knows its own system. |
| `ide` / `workspace` | the IDE hosting the agent, and the isolated workspace inside it | the IDE's own environment. [Orca](https://www.onorca.dev/) sets `ORCA_PANE_KEY` / `ORCA_TAB_ID` / `ORCA_WORKTREE_ID` on every agent pane; `ORCA_WORKTREE_ID` is what tells N parallel agents apart. `RETRACE_IDE` / `RETRACE_WORKSPACE` override for an IDE we cannot detect. |
| `surface` | `tty` (a human typed it) or `agent` (a harness ran it) | git hook only, from `/proc/self/stat` field 7 — not `isatty()`, which the hook's own `>/dev/null 2>&1` destroys. Linux-only; absent elsewhere. |
| `device` | the machine | `os.hostname()`, or `RETRACE_DEVICE` to override — a hostname is sealed into hash-covered bodies that share links serve pre-auth, and no later redaction is possible, so capture time is the only control point. |

On the git side `session`, `ide`, `workspace` and `surface` describe **the process that produced the commit**, so only the live post-commit hook stamps
them: `retrace-git backfill` and `retrace-git commit <sha>` replay commits the running process did not make, and
stamping there would seal today's session, IDE and terminal onto someone else's 2024 commit. The hook marks itself with
a `--hook` flag, so **re-run `retrace-git install` in repos hooked before this change** — an older hook script keeps
working and simply records none of the four.

Nothing is guessed: an IDE that does not name itself gets no `ide`, and terminal-emulator identity is deliberately **not**
recorded — inside WSL there is none to read (`TERM_PROGRAM`, `WT_SESSION`, `ITERM_SESSION_ID` are all absent and `TERM` is
identical everywhere), and stamping a guess would break the rule that a producer records only what it authoritatively knows.

**Orca + WSL:** Orca sets its vars on the Windows side and forwards only `HISTFILE` and the git-credential vars through
`WSLENV`, so they do not reach a WSL pane. To capture them there, add a user-level Windows
`WSLENV=ORCA_PANE_KEY/u:ORCA_TAB_ID/u:ORCA_WORKTREE_ID/u` — Orca appends to whatever `WSLENV` already holds, so yours
survives. Native macOS/Linux panes need nothing. In the UI, click a session or workspace value to search for it.

## Event shape (short)

```jsonc
{
  "project": "boxing-rpg",
  "actor": { "type": "agent", "id": "claude-code", "model": "claude-fable-5", "on_behalf_of": "jordan" },   // WHO
  "action": "edited", "artifacts": [{ "id": "repo:rpg#src/fight.ts", "kind": "file", "role": "both" }],     // WHAT · role = PROV used | generated | both (optional; absent = unspecified)
  "change": { "summary": "add jab counter", "after_hash": "…" },
  "timestamp": "2026-08-16T19:21:54Z",                                                                    // WHEN
  "location": { "path": "src/fight.ts", "system": "claude-code", "environment": "local",                  // WHERE
                "session": "e09a0ccf-…", "client": "claude-code@2.1.250",                                 //   who/where it ran (server-stamped)
                "ide": "orca", "workspace": "wt_feature_x", "surface": "agent" },                         //   IDE pane · isolated worktree · no tty
  "intent": "implement jab counter", "caused_by": "evt_…",                                                // WHY
  "method": { "tool": "Edit", "automated": true, "tokens": 1200,                                         // HOW
              "params": { "sealed_by": "pinned:claude-code MCP (pinned)" } },                             //   who sealed it (server-stamped on Worker writes)
  "seq": 1, "prev_hash": "…", "hash": "…"                                                                 // integrity
}
```

## Status / next

**Position:** Retrace is the causal evidence plane for human-directed AI work (who authorized, which agent/model, what it touched, how that reached a doc / commit / PR / deploy). Not generic AI provenance, not C2PA, not a trace viewer, not an IdP.

**Now:** niche 5 first slice is live. Drive #776 walks `caused_by` to instruct #773. `RETRACE_CAUSED_BY` is cleared. That property is a **global operator flag**, not evidence that the edit belonged to the task — later Drive work must not treat it as a sealed fact. Event #594 stays a root unless attested later.

**Next (earn “verifiable”, not more connectors):**
1. Completeness — `verifyExportBundle` reports omission for full exports (count, contiguous seq, head hash; scoped bundles say “not checkable”); `retrace-export checkpoint` + `verify --checkpoint` pin the head in a git-committed `.retrace/checkpoints.jsonl`, and `retrace-checkpoint.yml` appends one daily via a PR you merge. Security assessment 2026-08-30 fixed: signatures are `self_attested` (not `valid`) without a trusted key, `checkpoint` requires one; `hash_v: 2` is sealed into every new hash so a `received_at` edit or rule downgrade is tampering (events before the next Worker deploy stay legacy-hash and are counted); a full bundle missing the checkpointed seq is `CONFLICT` regardless of `generated_at`. Since closed: the Rekor transparency-log witness (`retrace-export witness`, verified offline with `--witnesses`), hourly Worker checkpoints witnessed in Rekor, and git-vs-ledger reconciliation (`retrace-export reconcile`, capture windows per file, the `capture coverage` gate finding). Still open: pagination / export truncation, and reconciling GitHub / Drive vs the ledger.
2. Seal what the server actually knows — `received_at` is hash-covered on new seals (`chain.ts` `hashPayload`). Events sealed with `hash_v: 2` have exactly one valid digest: a `received_at` edit or stripping the marker is tampering. Events without `hash_v` are still verified best-effort under either rule, so rewriting `received_at` on those legacy events is not detectable. A caller `timestamp` can still be earlier than `received_at`; both times are sealed, so backdating is visible. `caused_by` that fails exists/older/same-project is sealed with the link kept and tagged `caused_by:unverified` (`method.params.caused_by_problem`); status counts `unverified_links`. The git hook must not drop a commit because a trailer is stale or the instruct lives in another project/clone. `retrace_log` (MCP) still 400s so the agent can fix and retry. Sealed amendments that fail those rules are `ineffective_amendments`. Adapter idempotency prefixes (`git:` / `gd:` / `gh:`) are reserved at write so a caller key cannot shadow the git hook / Drive / GitHub mapper.
3. Attribution — `retrace doctor` uses the sealed `committed`/`merged` event for HEAD (not `events.at(-1)`). A human actor with `location.surface=agent` is warn locally and fail under `--gate`, including instruct-root. Pin/session: a sealed agent HEAD is compared to MCP peers on its why-chain (`203d34d`); replay with no session is not a miss. Every Worker write is stamped with **who sealed it** (`method.params.sealed_by` = `pinned:<credential>` / `assert:<credential>` / `owner` / `webhook:github` / `unauthenticated`; server wins), and status counts `sealed_by` plus `agent_events_not_pinned` — the agent events whose WHO is producer testimony rather than Worker-fixed. Still open: distinguish content author from committer and relayer on git events.
4. Local `retrace-serve` — default-closed since 2026-08-30: binds `127.0.0.1` and requires a token (a per-run one is generated and printed when none is configured); `RETRACE_OPEN=1` is honoured on loopback only. The UI stores a bootstrap/query or manually entered token per API endpoint, scrubs it from browser history, and uses bearer headers for API, export, and report reads.
5. Dogfood — boxing-rpg coverage is the honest metric; a second project above 95% beats another integration.

**Not next:** C2PA / line attribution, LangSmith / tracing, an IdP, TRACE/TEE, AI-BOM, a compliance-deadline pitch, adding Cursor to `retrace-admin` `HARNESSES` / treating it as a sixth product harness, a fourth trailer vocabulary, Claude-Code-only managed hooks as the completeness strategy, more adapters, batch-amending the ledger. Signed checkpoints / Rekor are a later export of completeness, not a reason to pause the gate. This checkout dogfoods a pinned `cursor-agent` identity (Worker credential + git-hook allow-list; token off-repo).

Done: core schema + chain (tested), MCP server (tested via in-memory MCP client), Worker + D1 store (smoke-tested locally with `wrangler dev`, live D1 schema applied), timeline UI (served locally and by the Worker; verified with Playwright incl. tamper detection), Git post-commit adapter (tested on a temp repo + dogfooded on this repo), Ed25519-signed exports + offline verify + printable report + read-only share links (tested incl. tamper/wrong-key), artifact lineage graph (core + UI + API + MCP; git commits now carry derived_from → parent commit), GitHub PR adapter (HMAC-verified webhook + backfill/replay CLI; simulated full PR lifecycle end-to-end), Google Docs/Drive adapter (Apps Script forwarder + POST /hooks/gdrive mapping + CLI; fixture-tested and simulated end-to-end; optional ingest-time `caused_by` 2026-08-29), CI provenance gate (`retrace doctor --gate` + required Actions check `gate`), PROV artifact roles (`role: used | generated | both` stamped by every adapter, defaulted by verb on `retrace_log`, shown as in/out markers in the UI, report and event text; deployed 2026-08-25), run context on WHERE (`location.client` from the MCP handshake, `ide`/`workspace` from the IDE's own env — Orca panes and worktrees — `surface` tty/agent from the git hook, and `session` now the harness's real session id so MCP events and the commits they drive share one key; server-stamped and caller-proof on the MCP path, live-hook-only on the git path).
Deployed: Worker version `a73fea86-ebdb-4352-b83c-99953d2741a9` on 2026-09-01 (`3d8539a` — `RETRACE_GITHUB_PUSH=1`, the push webhook seals every commit a second time; `605d5007` with `349c388` — hourly checkpoint cron witnessed in Rekor, D1 `checkpoints` table; prior `5f71b0ca` with `2acdcca` fail-closed 503 when unconfigured, share caching/rate-limit, LIKE/limit binding, `30c472e3` with `5f8c881` router hardening and `hash_v: 2` seals, `3d8edca8` sealed_by stamp). Claude Code, Codex, Gemini CLI, Grok, GitHub Copilot, and Cursor Agent now have separate scoped identities (Cursor runs the Grok model but seals as `cursor-agent`), and the git-hook credential allows commits from all six. This checkout also pins Cursor Agent (`cursor-agent`) the same way; `retrace-admin new-team` still does not mint it.

⚠ Ship order for any new `location`/event field: **core → `npm run build` at the root → deploy the Worker → producers → UI.**
`POST /events` re-parses with `EventInput.safeParse` and Zod strips unknown keys, so a field stamped before the Worker is
deployed is silently dropped from every remote-sealed event — accepted, sealed and hashed without it, with no error
anywhere. That has happened twice (`location.session`, `bacabed`; the run-context fields, 2026-08-28). Respawn the MCP
server afterwards — it captures its session id at spawn and keeps its old `dist` until it is restarted.

You no longer have to remember: `GET /api` publishes the schema surface a deployment understands, derived from the zod
shapes so it cannot drift from the code, and

```bash
npm run check-deploy                 # or: npm run check-deploy https://retrace-api.<you>.workers.dev
```

diffs it against the local build — exit 0 if the deployment understands every field you send, exit 1 listing the ones it
would silently drop. No token, no writes; run it after every deploy, and in CI if you add one.
Licensed under the [Apache License 2.0](LICENSE).
