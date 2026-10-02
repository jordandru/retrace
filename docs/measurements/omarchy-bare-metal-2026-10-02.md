# Omarchy bare-metal stranger trial, 2026-10-02 — measurement

**Status:** measurement, class (b) under agent-rules 12. It records what was measured and governs nothing. Filed
2026-10-02 by pull request on Jordan's signed go `evt_17bda44b5a484d8dbff7bc35602bf9ee` (gate G8). The working draft
is `REPORT.md` in the operator's local trial folder.

**Provenance.**
- **Who ran it:** the `claude-code` seat in a second Claude Code session (`claude-opus-5-5`, source `harness-runtime`).
- **Instructions:** Jordan's instruction `evt_1516160a…`, the coordinator's brief (routing `evt_6935bf99…`, verified on
  receipt `evt_e0b2c57a…`), and Jordan's signed gate decisions G1–G7 (listed under Evidence).
- **What it closes:** measurements 1, 2 and 4 of the 2026-09-21 trial (`docs/measurements/omarchy-trial-2026-09-21.md`),
  which never ran. Measurement 5 is the rule table below.
- **What it re-tests:** the 2026-09-20 same-laptop dry run (issues #83–#89).

## Verdict

**Yes, with the old caveats still standing.** On a freshly installed Omarchy 4.0.4 PC with no Retrace history and no
credential:
- The published `@retrace-dev/cli@0.2.0` went from nothing to a locally sealed commit and a verified export in about
  **20 seconds** (19.2 s wall clock, 9.9 s of it commands). This is for an operator who already knew the commands.
- The install itself behaved exactly as documented.

What still stops or misleads a stranger:
- The GitHub README never shows this install path (**F1**).
- Local `status` and `reconcile` still mislead (**F3**, **F5**), and SETUP-GUIDE and `examples.md` carry stale
  expectations (**F4**, **F6**).
- A commit made offline with a cold npm cache **loses its seal while `doctor` still says READY** (**N2**). Only
  `reconcile` notices.

## The box

| | measured (logs/step00, step01, step02) |
|---|---|
| hardware | AMD Ryzen 5 3600, 7.7 GiB RAM, AMD Radeon RX 5500 XT (`amdgpu`), Intel Wireless-AC 3168 (`iwlwifi`), SSD Neo Forza NFS011SA356 238.5 GB |
| OS | Omarchy **4.0.4-1**, kernel 7.2.5-3-omarchy, installed 2026-10-01 from the 4.0.4 ISO |
| ISO checks | gpg **Good signature**, key `40DFB630FF42BCFFB047046CF0134EE680CAC571` (`evt_335c89aa`). The sha256's first 8 and last 7 characters matched as read by Jordan (`evt_eb4e5106`); the full value was not transcribed. |
| disk | root on **LUKS** (`sda2 crypto_LUKS` → btrfs). Boot waits for the passphrase in the initramfs (`cryptdevice=` on the kernel command line). There is no TPM device (`/dev/tpm*` absent) and no automatic unlock. |
| user | `stranger`, groups `stranger wheel` (not `docker`); umask 0022 |
| Node | **v26.8.2 via mise**. It is on PATH in a non-interactive `bash -c`, and absent only in an empty environment (`env -i`). |
| git | 2.55.0; XDG config `~/.config/git/config` written by the installer (`user.name Stranger`, `user.email stranger@example.com`, `init.defaultbranch master`); `core.hooksPath`, `init.templateDir`, `commit.gpgsign` all unset |
| isolation | 0 `RETRACE_*` variables in the session, no `~/.retrace` before the install, no credential of any kind put on the box |
| network | the owner's home Wi-Fi (WPA2-AES). The phone hotspot measured about 2.1 Mbit/s (`evt_c6218b23`) and was too slow. |

## How it was run, and what that means for the numbers

- **Operator.** This seat drove the box over ssh, inside a `tmux` session that Jordan opened in the PC's own terminal.
  So commands ran in the desktop session's real environment, and Jordan watched them run. The commands came from a
  prepared step list (`trial/steps.md`), not from a person reading the docs cold.
  - **So the 19.2 s excludes reading time.** The doc-path question is answered separately (step 03, F1).
- **The single connection.** One multiplexed ssh connection was used throughout, because the box's firewall
  rate-limits new SSH connections (O2 below).
- **Deliberate changes from a stock install:** SSH enabled; one trial key authorised; lingering enabled at G7; a stub
  `systemd --user` timer added. All are removed or reverted at G9. The installer stick stayed plugged in (`sdb`).

## Elapsed (from step markers on the box; logs/stepNN-*.log)

| step | what | seconds | result |
|---|---|---|---|
| 04 | throwaway repo + 3 commits, `doctor` (cold npx), `retrace-git install`, `doctor`, hook file | 7.54 | NOT READY (2 FAIL) → installed → READY 5/1/0 |
| 05 | fourth commit | 0.62 | sealed locally (`~/.retrace/retrace.db`, 143 kB); terminal shows only git's own line |
| 06 | export → verify → verify `--allow-self-attested` | 1.75 | `NOT VALID … self_attested` exit 2 → `VALID` exit 0 (as the README says) |
| — | **C95 basis: first command of 04 to the end of 06** | **19.2 wall / 9.9 commands** | 20:27:10.302Z → 20:27:29.544Z (14:27 MDT) |
| 07 | npx cache moved aside, online, commit | 1.04 | sealed (npx re-fetched) |
| 08 | both npm caches aside, **no network** (`unshare -rn`), commit | 71.74 | commit blocked **70.3 s**, exit 0, **not sealed** (N2) |
| 09 | `reconcile`, `reconcile --allow-unstamped-seals`, `status` | 2.50 | see F3, F5, N2 |
| 10 | `retrace-mcp` stdio initialize + tools/list | 0.69 | 11 tools, 10,860 bytes; serverInfo "0.1.0" (N1) |

C95 ("Installation in under ten minutes", `docs/design/evaluation-response-plan-2026-09-24.md:249`) gets its first
number: **about 20 s of tool time on this box**. Excluded: Node (Omarchy preinstalls it via mise) and documentation
reading, which F1 makes the real cost for a stranger.

## Re-tests of the 2026-09-20 findings (reproduced / fixed / changed — none reported as new)

| finding | at 0.2.0 on Omarchy | evidence |
|---|---|---|
| **F1** README assumes a checkout (#83, open) | **Reproduces.** The GitHub README's Quick start is still `npm install && npm run build && npm test` and never names `retrace-git`. The npm page's README does name `npm exec --package=@retrace-dev/cli -- retrace-git install --project my-project`. Which README a stranger opens decides it. | step03 |
| **F2** hook hard-codes the npx cache; doctor blind (#84, closed) | **Fixed online.** The hook is `npx -y -p @retrace-dev/cli@0.2.0 retrace-git commit --hook …`, and doctor probes it ("retrace-git 0.2.0"). **Changed offline:** a miss is now printed and appended to `.git/retrace-hook.log`. But doctor still reports READY over it: see N2. | step04, 07, 08 |
| **F3** `retrace status` refuses a local ledger (#85, open) | **Reproduces.** "RETRACE_URL or .retrace.json url is required", exit 1. | step09 |
| **F4** SETUP-GUIDE expects `FAIL credential` (#86, open) | **Reproduces.** SETUP-GUIDE.md:105 (main `ce8c7cc`) says to expect it. Doctor actually prints `WARN deployment … READY`. | step04 |
| **F5** reconcile rejects every local seal (#87, open) | **Reproduces.** Without the flag: "6 commits, 0 sealed — 6 missing", every seal "unstamped … nothing authenticated this commit". With `--allow-unstamped-seals`: 2 sealed, 4 missing (3 pre-install, plus N2's offline commit). | step09 |
| **F6** examples.md "4 of 4 events" (#88, open) | **Reproduces.** The public NOOA share verifies `VALID … 6 of 6 events; producer sigs: 6 verified` against the well-known key. examples.md:108 still says 4 of 4. | run-…210637Z-report-gaps |
| **R1** repair text names a bare binary (#89) | **Reproduces.** "run retrace-git install --repo …", while no `retrace-git` is on PATH. | step04 |
| **R3** a sealed commit gives no feedback (#89) | **Reproduces**, and is now fully silent: the SQLite warning that was 09-20's only output is suppressed in the hook. | step05 |
| **R5** several spellings (#89) | **Reproduces:** `npx -p …` (README), `npm exec --package=…` (npm README), bare `retrace-git` (doctor). | step03, 04 |
| R2, R4 (#89) | not re-tested | — |

## New findings

- **N1 — `retrace-mcp` reports serverInfo version "0.1.0" in every release (Low).** On the box it answered
  `{"name":"retrace","version":"0.1.0"}` while the package is 0.2.0. The cause is
  `packages/mcp-server/src/index.ts:173`, a literal unchanged since `e5d81f4`. The 09-20 raw log showed the same string
  but the finding was not reported. Draft: `issues/draft-mcp-serverinfo-version.md`.
- **N2 — offline with a cold npm cache, a commit blocks about 70 s and loses its seal while doctor stays READY
  (Medium).** The hook's `npx` cannot fetch the package (`EADDRNOTAVAIL`).
  - What works: the commit still succeeds, the error is shown and logged to `.git/retrace-hook.log`, and `reconcile`
    reports the commit missing.
  - What doesn't: no `.git/retrace-pending-seal` is written, so after the caches are restored `doctor` prints
    `READY … pending seals … empty`. A user who trusts doctor is misled. The hang is also a usability cost.
  - Draft: `issues/draft-offline-cold-cache-seal-loss.md`.
- **N3 — a fresh Omarchy box arrives with an AI coding agent installed (information).** Omarchy's own installer runs
  `omarchy-mise-install codex` (`/usr/share/omarchy/install/user/mise.sh:5`).
  - Codex 0.160.0 landed at 2026-10-02 14:10:18 MDT, soon after the box first had network. Nobody ran it (Jordan,
    `evt_c89ce169`).
  - Omarchy's shell "agents" plugin keeps usage files for Claude, Codex and Fireworks.
  - Retrace is not wired to any of them. For Retrace, the stranger's box already carries an agent whose work would go
    unrecorded unless the stranger connects it (`evt_7446a21e`).

## Other observations (not Retrace defects)

- **O1:** Omarchy's *Setup > Security > SSHD* installs and enables sshd, opens port 22 rate-limited, and then prompts
  for a public key to paste. The server offers `publickey,password`.
- **O2:** the rate limit refuses a burst of a few new connections (an ssh-copy-id run failed twice that way), so
  scripted access should use one multiplexed connection.
- **O3:** the disk-unlock prompt at boot looks like a login screen, and a successful unlock **logs the user in
  automatically**. A power cut leaves the box offline and doing nothing until a person types the passphrase.
- **O4:** at logout `user@1000.service` did not stop within its timeout and was SIGKILLed after 15 s.
- **O5:** no `retrace` name collision on PATH (unlike the laptop's Android `/usr/bin/retrace`). The clipboard text
  history (09-21's F2 path) was absent, because nothing was copied on the box: inconclusive.

## Measurement 4: an auditor-style `systemd --user` timer (stub, every minute)

| condition | result | evidence |
|---|---|---|
| linger **off**, user logs out (14:36:33 MDT) | **stops**: no ticks while logged out; one catch-up tick at login (`Persistent=true`) | `evt_eaedb571`, run-…204709Z |
| `loginctl enable-linger stranger` as the user | succeeded **without a password** | run-…204729Z |
| linger **on**, reboot | nothing runs until the LUKS passphrase is typed (about 8 min here); after unlock, the linger manager and the autologin session start in the same second | `evt_3ec727c6` |
| linger **on**, user logs out (14:59:23–15:02:39) | **keeps running**: 3 ticks while nobody was logged in, same user-manager process | `evt_856c7998` |

So an hourly auditor (role c) could run as a user timer here once lingering is on. But under the default encryption, any
reboot or power loss needs a person at the keyboard.

## Measurement 5: agent-ops rules 1–19 on the Omarchy box

| rule (agent-ops at `ce8c7cc`) | hazard it guards | on Omarchy | what it means for "unnecessary when" |
|---|---|---|---|
| 1 own worktree per task | many seats, one clone | not testable (one seat) | — |
| 2 `git commit --only` | uncommitted work swept by another committer | not testable (one seat) | — |
| 3 hooks run the primary checkout's dist | common `.git/hooks` across worktrees | **condition met for npx installs**: the stranger's hook runs the packed CLI pinned by version | The retirement condition already holds for npx installs. The laptop's checkout-installed hooks still run a dist (`node "<path>"`). |
| 4 fresh worktree needs a build for MCP | configs launch a worktree's dist | **packed path works**: `npx -p @retrace-dev/cli@0.2.0 retrace-mcp` answered on a fresh box with no build | Retiring it needs only the repo's MCP configs switched to the pinned npx form. |
| 5 clear `dist` before verifying a PR head | stale compiled tests | not testable (no checkout) | — |
| 6, 7 MCP server lifecycle | harness keeps a dead or stale server | not testable (no harness wired) | — |
| 8 Cursor `envFile`, 9 Copilot stdio | one harness each | not testable | — |
| 10 test env inline | a shell that tests and commits | not testable (no test suite) | — |
| 11 doctor flakes on a WSL2 fetch timeout | WSL2 networking | **premise absent** (no WSL2); every npm/npx fetch succeeded online; doctor's Worker path not exercised (local only, no credential by design) | It retires with WSL2 for this box; not evidence about the Worker path. |
| 12 merges from a detached worktree | merge in progress in the primary tree | not testable | — |
| 13 credentials in the Worker secret | where credentials live | not testable (product) | — |
| 14 one coordinator | coordination | not testable | — |
| 15 Cursor effort / Orca `--command` | harness/Orca | not testable (no Orca) | — |
| 16 terminal boundary; never paste a fence | transcripts, pane env, clipboard | **held by design:** nothing was pasted onto the box; secrets (disk/user password, key passphrase) were typed only at the PC or in a plain terminal outside Orca. The paste test was not repeated (foot was measured 09-21); the bare-metal default terminal was not identified. | No change. |
| 17 Docker is root | the `docker` group / an open engine | **hazard absent by default**: docker installed but inactive; the user is not in `docker` (matches the Omarchy manual) | Omarchy's default already meets the condition's Linux-socket half. |
| 18 signed pane messages, 19 declare `gh` writes | agent-to-agent sends; owner-identity GitHub writes | not testable (no panes, no `gh` writes) | — |

## Limits

- One box, one run, one operator (an agent with a prepared step list), on home broadband.
- The C95 number excludes reading the docs and installing Node.
- Measurement 3 was not repeated, and the default terminal was not identified.
- The clipboard sink is inconclusive.
- R2 and R4 were not re-tested.
- The ISO's sha256 was matched by its ends only. The gpg signature covers every byte.
- Nothing here is called verified that the logs do not show.

## Evidence

**Local, and not in this repository:** the trial folder `~/.retrace/omarchy-pc-2026-09-30/` on the operator's laptop.

**Logs** in its `logs/`:
- `step00`–`step12`: each has a raw file and an ANSI-stripped file, with BEGIN/END markers and a per-command exit
  code.
- `run-*.log`: the read-only checks.

**Photos** in `evidence/photos/`, numbered as Jordan sent them: 01–08 before the install, 10, 11–13, and 17. Each
sha256 is sealed on the ledger.

**Ledger thread:**

| step | events |
|---|---|
| receipt | `evt_ec5d7897` (instruct), `evt_e0b2c57a` (receipt verified) |
| G1 | `evt_97da5b8d`, `evt_335c89aa`, `evt_eb4e5106` |
| G2 | `evt_024400fa`, `evt_6414ffda` |
| G3 | `evt_a950504f` |
| G4 | `evt_a5a70bc6` |
| G5 | `evt_4f210bff`, `evt_9ad49ae3` |
| G6 | `evt_12a10d0e`, `evt_6c172904`, `evt_0c4a624f`, `evt_79770c5d`, `evt_b68cdc47`, `evt_7446a21e`, `evt_552a96ae` |
| G7 | `evt_9439b227`, `evt_eaedb571`, `evt_3ec727c6`, `evt_856c7998` |

**Rehearsal** (laptop, preparation only): `rehearsal-laptop/SUMMARY.md`.
