# The OpenShell seat: sandbox image, provider profiles and harness configuration (W4)

**v2, 2026-10-05 (fix round 1):** the round-1 Lows resolved in place: NOOA L1 (`GH_TOKEN`) and L2 (`RETRACE_ACTOR_LOCK`), Grok G-L1
(`RETRACE_ACTOR_LOCK`), G-L2 (environment beyond the design), G-L3 (copy headers; the packed-CLI citation). Verdicts
`evt_18aed904a1d64aa1aca083820250024c` (NOOA) and `evt_cb932db09b7d46c3839700e8447c414e` (Grok); fix-round routing
`evt_9d99d9869d31495d95e32b899ec5ead1`; Jordan's decision `evt_46eff022eab846eba559198f3f52ca14`. Dispositions in §"Changes in v2" below.

**Status:** W4 of `docs/design/openshell-seat.md` v2 (the design of record, on main `fab82ea9`). Class (a) under agent-rules 12:
these files govern what the seat can reach and do. **Nothing here is built or applied by merging it.** Jordan builds the image
and applies the profiles on the PC; the credentials come later (W5) by his typed scripts; the probe (W6) runs only after the
bounded probe exception (W6a) has merged. This directory holds no secret and no credential value.

## What is here

| File | Becomes | Governs |
|---|---|---|
| `Containerfile` | the image `localhost/retrace-openshell-seat:<tag>`, built on the PC with `podman build` | what software the seat runs, all pinned: node 22.23.3, Claude Code 2.1.289, `@retrace-dev/cli` 0.3.0, GitHub CLI 2.102.0, git, curl, and three apt packages the design does not name: `ca-certificates` (TLS roots for curl and node), `xz-utils` (to unpack the node tarball), `perl` (Stage 1's probe clients are perl); a clone of this public repository with the Retrace hooks installed; the non-secret environment (design §3.1, §5.1) plus two switches beyond the design's two: `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, redundant with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` by Claude Code's documentation and kept so each stays off if the umbrella's coverage changes; the seat user (uid 1000). The hook install runs under a meaningless build-time token because every `retrace-git` subcommand resolves a token first (`packages/mcp-server/src/git-hook.ts` line 426 at main `fab82ea9`) |
| `profiles/retrace-worker.yaml` | the provider type for the Retrace token | one credential under two names (`RETRACE_TOKEN`, `RETRACE_HOOK_TOKEN`), bearer, bound to the Worker's host; binaries node, the Retrace CLI package, curl (design §2.2.3) |
| `profiles/claude-code-seat.yaml` | the provider type for the Anthropic API key | OpenShell's `claude-code` profile minus its two telemetry hosts; one env name (`ANTHROPIC_API_KEY`, the documented one; the shipped `CLAUDE_API_KEY` alias dropped); binaries as installed (design §5.2). Every difference is listed in the file's header |
| `profiles/github-seat.yaml` | the provider type for the GitHub token | OpenShell's `github` profile plus one rule: `POST /jordandru/retrace.git/git-receive-pack` (design §5.2, §6); binaries narrowed to the two paths the image installs; `env_vars` keeps the shipped pair `GITHUB_TOKEN, GH_TOKEN` (the design names only the first): the GitHub CLI reads `GH_TOKEN` then `GITHUB_TOKEN`, both names carry one placeholder, and a second name widens no host, rule or permission |
| `CLAUDE.seat.md` | `~/.claude/CLAUDE.md` in the image | the seat's identity block: not `claude-code`; read-and-report until W6a; the bound; the dispatch verification (design §2.4) |
| `settings.json` | `~/.claude/settings.json` in the image | the push guard as a `PreToolUse` hook; the repository's `retrace-cloud` MCP entry disabled (design §5.3) |
| `claude.json` | `~/.claude.json` in the image | the seat's user-scope MCP server: `retrace-mcp` over stdio, with exactly the design §5.3 environment: `RETRACE_URL`, `RETRACE_PROJECT`, `RETRACE_ACTOR`, `RETRACE_ON_BEHALF_OF`, `RETRACE_ACTOR_LOCK=1`; `RETRACE_TOKEN` (a placeholder) and `RETRACE_DEVICE` are inherited from the sandbox environment. **The actor lock is on**: the server defaults it on unless the variable is `"0"` (`packages/mcp-server/src/index.ts` line 178), rejects human and system actors and ignores a caller-supplied id or principal, and, because the server environment pins no model, passes the caller's `actor.model`, `model_source` and `model_claims` through as sent (lines 269–276). So the seat's identity comes from the environment and the server pin, and its model from the harness, as agent-rules 4 wants |

The runtime network policy is the union of the three profiles' endpoints and nothing else: the Worker, `api.anthropic.com`,
`api.github.com` (read-only) and `github.com` (clone, fetch, and push to this one repository). No package registry, no
`downloads.claude.ai`, no telemetry host.

## Dependencies this directory does not satisfy by itself

- **W3 (code).** The push guard's selector today is `CLAUDE_CODE_REMOTE=true`; W3 adds `RETRACE_SEAT=claude-code-openshell`. Until
  W3 merges, the hook in `settings.json` runs the guard and the guard exits 0 in the sandbox: the policy control is inert, and the
  seat's own bound (`CLAUDE.seat.md`) is what holds. W3 also adds the seat to the harness list and the no-key exception, which W5
  needs to mint the credential.
- **W6a (rules).** The bounded probe exception to agent-rules 7 and the `CLAUDE.md` selector clause. Until it merges, the seat
  reads and reports only, as `CLAUDE.seat.md` says.
- **W5 (custody).** Three providers created on the PC from Jordan's typed scripts, each value carried once over SSH into
  `openshell provider create --from-existing` (design §2.2). Names: `retrace-seat` (type `retrace-worker`), `anthropic-seat`
  (type `claude-code-seat`), `github-seat` (type `github-seat`). No value appears in this repository, in Orca, or in a transcript.

## Jordan's steps at the PC (each on its own go; the observation that passes it)

Run as `stranger` in a plain terminal on the PC, from a fresh clone of the repository at the merged commit. The PC's SSH stays off
except while a session needs it.

1. **Lint the profiles.** `openshell profile lint -f sandbox/openshell/profiles/<name>.yaml` for each of the three.
   Passes when each prints no error.
2. **Import the profiles.** `openshell profile import -f sandbox/openshell/profiles/<name>.yaml --global` for each.
   Passes when `openshell profile list` shows `retrace-worker`, `claude-code-seat` and `github-seat` with source "imported".
3. **Build the image.** `podman build -t localhost/retrace-openshell-seat:w4 -f sandbox/openshell/Containerfile sandbox/openshell`.
   Passes when the build ends with the image id, and `podman image inspect localhost/retrace-openshell-seat:w4 --format
   '{{.Digest}} {{.Id}}'` prints a digest; record both in the W6 record. The build downloads node, the GitHub CLI and two npm
   packages at the pinned versions and clones the public repository; it needs the PC's network, outside any sandbox.
4. **Create the providers** (W5, by the typed scripts, one go each). Passes when `openshell provider list` shows the three
   names and no value was printed anywhere.
5. **Create the sandbox.**
   `openshell sandbox create --name seat --from localhost/retrace-openshell-seat:w4 --provider retrace-seat --provider
   anthropic-seat --provider github-seat --cpu 2 --memory 3Gi -- claude`
   Passes when the sandbox reports Ready and `openshell sandbox exec -n seat -- printenv RETRACE_TOKEN` prints a value that
   starts with `openshell:` (a placeholder, Stage 1 test 2), never anything else. `--cpu 2 --memory 3Gi` is the estimate from
   design §5.1 for the 8 GB machine; W6 measures it.
6. **Attach and check the configuration.** `openshell sandbox connect seat` attaches to the harness. Inside it, `claude mcp list`
   shows `retrace` (stdio) and not `retrace-cloud`; the first prompt is the probe's dispatch line (W6), nothing else.
7. **Stop and tidy.** `openshell sandbox stop seat` between sessions; `openshell sandbox delete seat` when the probe is done;
   providers are deleted by the typed scripts when a credential is retired (design §6). SSH off.

Never: `--env` with a credential value (OpenShell warns, and the agent could read it); a bind mount of anything outside a scratch
directory; a second credential for a seat that has one; a host-level `claude` signed in while a real token is in the gateway's
store (design §6).

## What this directory does not claim

- That the image builds, that the profiles import, or that the sandbox starts. Nothing here has been run; W6 measures it on the PC.
- That OpenShell attributes Claude Code's traffic to the `binaries` listed. The profile's own header says an npm install may
  resolve elsewhere; the three paths listed follow that guidance, and a denial in W6 is the measurement that corrects them.
- That `~/.claude.json` with a top-level `mcpServers` key is read by Claude Code at user scope exactly as written here. Claude
  Code documents that file as the home of MCP server configurations; step 6's `claude mcp list` is the check.
- That the pinned versions are current when the image is built. They are the versions published on 2026-10-05; raise them
  together, in this file and the Containerfile, by a pull request.

## Changes in v2

| Finding | Disposition |
|---|---|
| NOOA L2, Grok G-L1 (Low): `claude.json` omitted `RETRACE_ACTOR_LOCK=1` and the author's reason ("no lock, so the caller's model passes") was wrong | **Applied.** `RETRACE_ACTOR_LOCK=1` added, as design §5.3 states. The lock is on by default anyway (`index.ts` line 178) and passes the caller's model when the environment pins none (lines 269–276); the `claude.json` row above says so with those lines. The wrong reason stood in the author's created event, not in this directory; it is corrected in the edit event |
| NOOA L1 (Low): `GH_TOKEN` beside `GITHUB_TOKEN` in `github-seat.yaml` while the design names only `GITHUB_TOKEN` | **Applied, kept.** The GitHub CLI reads `GH_TOKEN` then `GITHUB_TOKEN`; both names carry one placeholder of one credential and widen nothing. Stated in the profile header and in the table above |
| Grok G-L2 (Low): environment beyond the design (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` in the image; `RETRACE_DEVICE` in `claude.json`; apt packages not named) | **Applied.** `RETRACE_DEVICE` removed from `claude.json` (inherited from the image environment, where §3.1 puts it). The two switches and the three apt packages are kept and named with their reasons in the `Containerfile` row |
| Grok G-L3 (Low): copy headers understated the differences from the shipped profiles | **Applied.** Each header lists every body difference: renamed ids and descriptions; `CLAUDE_API_KEY` dropped; the two telemetry endpoints removed; binaries replaced; the one added rule; binaries narrowed from four to two |
| Grok G-L3 (Low): `git-hook.ts` 426–446 cited for the install-time token resolution does not match the packed `git-hook.js` | **Applied.** The Containerfile and this file cite the TypeScript at main `fab82ea9`: `packages/mcp-server/src/git-hook.ts` line 426 (`const cfg = loadCfg(repo, flags)`), the `install` branch at line 428, compiled into the packed CLI 0.3.0 |
