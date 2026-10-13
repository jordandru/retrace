# Orca on the Omarchy PC, 2026-10-04/05 — native install under Hyprland, measurement

**Status:** measurement, class (b) under agent-rules 12. It records what was measured and governs nothing. Filed
2026-10-05 by pull request on Jordan's signed go `evt_a80739ab…`. The PC session's full report (21,997 bytes, sha256
`e8aea9c218d1599a867f58f5c60e971ef4b34cf748cda289856b5fac68a1427c`) and its two working notes are in the operator's
local folder and are not in this repository; this document is written from them.

**Provenance.**
- **Who ran it:** a Claude Code session on the Omarchy PC itself, inside the user account of the 2026-10-02 trial.
  **It is not a Retrace seat:** no credential, no ledger, no MCP server. Its report states the model id its harness
  showed, `claude-fable-5-1`; that is the session's own report, relayed, not a sealed claim. Jordan sat at the PC's
  keyboard for every decision, password and sign-in.
- **Who wrote the prompt and this document:** the `claude-code` seat on the laptop (`claude-fable-5-1`, source
  `harness-runtime`), in a session separate from the coordinator's. The prompt (5,805 bytes, sha256 `054b16b070b6…`)
  reached the PC over the trial's ssh route and was verified identical there (`evt_f25dca09…`).
- **Gos, all JD-signed:** the question "Best IDE for Omarchy?" `evt_1842c4ab…`; draft the prompt `evt_9881d2f7…`;
  finalize `evt_3140125a…`; the PC session's summary relayed `evt_71f6c7e5…`; delete the PC's local Retrace files
  `evt_882e42e0…`; this document `evt_a80739ab…`.

## Verdict

**Orca runs natively on Omarchy, from the AUR package, with zero failures.** Orca 1.4.220 (Stably AI's agent
development environment, MIT) installed in 5 minutes 33 seconds through `stably-orca-bin` 1.4.220-1, a third-party AUR
repackaging of the vendor's AppImage. The AppImage the package downloads matched the vendor's `latest-linux.yml` sha512
and the PKGBUILD's sha256 exactly. The window is native Wayland, Claude Code runs in an Orca pane, the install survived a
logout and a reboot, and none of the three open Linux AppImage issues reproduced, because the package runs the extracted
tree and never mounts or self-replaces an AppImage.

**Two things a stranger would not expect.** Orca's first launch rewrote the user's Claude Code settings file, 76 bytes to
45,625, adding hooks for 13 events and a status line, without saying so on screen (its own backup kept). And the "credential-free" PC
turned out to hold a local Retrace store and a self-made local key, created by Retrace's own CLI and test suite, not by
anything copied from the laptop; both were deleted after a read-only look. The look found a defect in Retrace's test
suite (below).

## The box and the install

| | measured |
|---|---|
| host | the Omarchy PC of `docs/measurements/omarchy-bare-metal-2026-10-02.md`: Omarchy 4.0.4-1, Hyprland 0.56.2, kernel 7.2.5-3-omarchy, AMD RX 5500 XT on `amdgpu` with Mesa 26.2.2, user `stranger`, on a phone hotspot. `ufw` active. `fuse2` not installed. |
| Omarchy's Electron setting | `/usr/share/omarchy/default/hypr/envs.lua` sets `ELECTRON_OZONE_PLATFORM_HINT=wayland`, so the Electron app came up native Wayland with no wrapper or flag added. |
| route chosen | **A: AUR `stably-orca-bin`** (maintainer `thenomadcode`, on AUR since 2026-04-16, bumped the same day as each release, 4 votes), on two conditions checked before installing: PKGBUILD source is `github.com/stablyai/orca/releases/download/v1.4.220/orca-linux.AppImage`, and the download's sha256 `aedd0fa8…` equals the PKGBUILD's while its sha512 equals the vendor's `latest-linux.yml`. Orca's README names `yay -S stably-orca-bin` as the Arch path. Route B (vendor AppImage, self-updating) was not taken. |
| what the package does | extracts the AppImage to `/opt/stably-orca`, installs `/usr/bin/stably-orca` (runs `AppRun --disable-features=Vulkan`), a `.desktop` entry, icons; 642 MB on disk, 4,604 files; all nine dependencies were already present. Updates come through `omarchy update` → `yay -Sua`. |
| how it was installed | through Omarchy's floating presentation terminal, the same path as its own *Install → AUR* menu, so the sudo prompt appeared on Jordan's screen and never passed through the agent. A second 218 MB download was accepted for stranger-install fidelity rather than pre-seeding yay's cache. |
| the clone | `~/code/retrace` did not exist; the session made an anonymous HTTPS clone of the public repository (7.1 MB, head `6190d5f`) and made it read-only: push URL `DISABLED`, a local pre-commit hook that refuses. Git identity in it is the generic `Stranger <stranger@example.com>`. |

## Results (checks a–h of the prompt)

| check | result | evidence (from the report) |
|---|---|---|
| a. starts from Omarchy's app launcher | **Yes** | window at 23:26:02 MDT; transient unit `app-orca-<pid>.scope` under `systemd --user`, the launcher's `uwsm-app -- gtk-launch` path |
| b. native Wayland, not Xwayland | **Yes** | `hyprctl clients`: `class=orca … xwayland=false`; Chromium helpers carry `--ozone-platform=wayland` |
| c. a terminal pane opens | **Yes** | pane shell `bash --rcfile <Orca wrapper>`, cwd the clone, child of Orca's daemon; PATH carries the mise shims so `claude` resolves |
| d. Claude Code starts in a pane | **Yes** | `claude` process with `ORCA_AGENT_PANE` set, parent chain bash → Orca daemon → Orca → `systemd --user`. Jordan's Claude sign-in (`~/.claude/.credentials.json`) already existed from 2026-10-04 16:15 MDT, so no sign-in was prompted |
| e. the clone opens read-only as a folder | **Yes** | `ORCA_WORKSPACE_ID` names the clone; `git status` clean after Orca opened it; no `.orca` or `orca.yaml` written into the repo; no push, no commit |
| f. the Linux CLI responds | **Yes** | Jordan registered it (Settings → General → Orca CLI): `~/.local/bin/orca-ide → /opt/stably-orca/resources/bin/orca-ide`; `orca-ide --version` → 1.4.220; `status --json` → `ok:true`, runtime `ready`, `connected` |
| g. survives logout/login and a reboot | **Yes** | journal: logout 00:02:42 MDT, login 00:03:03, Orca from the launcher 00:03:10; reboot (new boot id) 00:08:41, login 00:08:48, Orca 00:08:53; after reboot `xwayland=false`, `.desktop` and CLI link present, `pacman -Q` 1.4.220-1, session restored by Orca's daemon; `coredumpctl` empty for orca and crashpad across a quit, the logout and the reboot |
| h. the update path | **Named, not tested** | `omarchy update` → `omarchy-update-aur-pkgs` → `yay -Sua`; `yay -Qua` empty (AUR = vendor latest). Caveat: Orca still reports `remoteUpdateSupport {installMode: interactive, automatic: true}` and ships `app-update.yml`, so it may *offer* self-update on a package-managed install; what it does then is untested |

## Timing and friction (the stranger-install numbers)

| phase | duration | Jordan's manual steps |
|---|---|---|
| 1. read before acting (manual, README, docs, PKGBUILD, hash checks, one 218 MB download at 1.75 MB/s) | 10 min 22 s | 0 |
| decision wait (route) | ~23 min | 1 |
| 2. install (second 218 MB download, extract, package, `pacman -U`) | **5 min 33 s** | 2 (sudo password; close the terminal) |
| 3. first launch and checks a–f | 18 min 19 s | 6 |
| 4. quit/relaunch, logout/login, reboot (check g) | ~18 min | 6 |

Totals: **15 manual steps** plus 3 decisions (route, clone, the MCP prompt); about 437 MB downloaded for the app and
7.1 MB for the clone; **0 failures**, no workaround applied.

Friction a new Omarchy user would meet: sudo asks for the password (no NOPASSWD for pacman or yay); the AUR website
refuses non-browser fetches (Anubis), though `yay -G` fetched the PKGBUILD cleanly; the settings rewrite below; Hyprland
started Xwayland at launch although the Orca window itself is native; startup opened two outbound HTTPS connections
(one into GitHub's address range, one unattributed) and Orca bound two **loopback-only** listeners (`127.0.0.1:6768`,
`127.0.0.1:40315`).

## What Orca wrote on the machine, outside its own directories

- **`~/.claude/settings.json`, rewritten at first launch** from 76 bytes (Omarchy's `theme` line and two keys) to 45,625
  bytes: `hooks` for 13 events (SessionStart, UserPromptSubmit, Stop, StopFailure, SubagentStart, SubagentStop,
  TeammateIdle, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PostCompact, SessionEnd) and a
  `statusLine` command. Each hook is an inline `sh` snippet that exits 0 unless `ORCA_AGENT_HOOK_PORT`,
  `ORCA_AGENT_HOOK_TOKEN` and `ORCA_PANE_KEY` are set, so it is inert outside Orca panes but runs for every hook event of
  every Claude Code session on the machine. Orca kept its pre-write copy as `settings.json.bak`. Upstream: Orca issues
  #24873 (hooks written even when `CLAUDE_CONFIG_DIR` is set) and #14301 (status line rewritten on every launch).
  Jordan ruled to leave it (2026-10-05 00:14 MDT).
- `~/.orca/agent-hooks/` (hook scripts for claude, codex, copilot, cursor, gemini, grok, muse) and `~/.config/orca/`
  (Electron user data, `orchestration.db`, a daemon socket, pid and token, an E2EE key pair and an agent-session
  authority key, shell wrappers, terminal history, logs). Names were listed; contents were not read.
- `~/.local/bin/orca-ide` (symlink), created by Jordan's click in Settings.
- Not changed: anything under `/usr/share/omarchy/`, `~/.config/hypr/`, `~/.config/omarchy/`; no systemd units; no
  Hyprland bindings; no git credentials; no `gh auth login`; no MCP server configured.

The Claude Code started inside Orca, in the clone, prompted to use the repository's project MCP server `retrace-cloud`
(`.mcp.json` → the Worker's `/mcp`). The session advised "continue without", since the PC is not a seat, and Jordan
declined the server. Nothing was typed by the agent at any sign-in or password prompt.

## Custody findings

1. **The PC held a local Retrace store and key, from Retrace's own tools.** `~/.retrace/signing-key.json` (242 bytes,
   mode 0600, 2026-10-02 14:27 MDT) is the local export-issuer key the published CLI creates by itself on first use
   (`packages/mcp-server/src/keys.ts`); registered nowhere, it has no authority at the Worker. `~/.retrace/retrace.db`
   (163,840 bytes, 2026-10-04 19:36 MDT) is the CLI's default local store. A read-only look from the laptop
   (`evt_d2cd5349…`) found six events: two `committed` by `stranger@example.com` from the 2026-10-02 trial's sample
   repository, and four under project `rpg` by `jordan@slcwitit.com` with artifact ids `commit:retrace-git-evicted…` and
   `commit:retrace-git-merge-u…`. Those four are **test fixtures**: the author is hard-coded in
   `packages/mcp-server/src/git-hook.test.ts` (lines 20, 35, 39). Nothing in either file came from the laptop, and
   nothing on the PC can reach the Worker. Jordan deleted both files by hand on 2026-10-05 (`evt_97f688af…`).
2. **A defect in the test suite** (finding `evt_ef92735d…`, class (c) fix, issue not yet filed): the evicted-cache test
   installs the hook with `RETRACE_DB` set (line 597) and then commits with an environment that carries no `RETRACE_DB`
   (line 600), so the hook seals into the real default store. On the laptop the inline test environment of agent-ops 10
   masks it; a plain `npm test` on the PC at 19:36 MDT wrote it. A stranger who runs the suite gets a polluted local
   ledger with events attributed to "Jordan".
3. **Jordan's own Claude Code sign-in** has lived on the PC since 2026-10-04 16:15 MDT. It is his account, not a Retrace
   credential, and it stays; the learn-to-code plan's "no credential of any kind" was corrected the same night.
4. **Phase B, the remote runtime, was documented and not enabled.** Enabling it means a WebSocket listener on
   `0.0.0.0:6768`, a pairing URL (`orca://pair?code=…`) that carries a device credential and end-to-end-encryption
   material, a `ufw` allow rule, and a network path (LAN, Tailscale, or Orca's cloud relay with an Orca account). A paired
   client can do everything the runtime can on that machine: open terminals, run agents **with the machine's
   credentials** (its Claude sign-in, any git or `gh` state), edit files in opened worktrees, commit and push, drive the
   built-in browser. For this PC that means whoever pairs acts as its Claude Code account. It is Jordan's go, not given.

## What this means for Retrace

- **Orca on Linux is real and cheap.** A sandboxed seat on the PC (the OpenShell implementation scope, S1) can run the
  same IDE as the laptop; the environment rules written for Orca panes carry over unchanged.
- **Orca occupies the user-level Claude Code hooks.** Any Retrace capture hook for Claude Code (the capture-hook design in
  progress) must coexist with 13 Orca hook entries in `~/.claude/settings.json`, and must expect that file to be
  rewritten by Orca at launch. Project-level hooks (`.claude/settings.json` in the repository) are the safer home.
- **The test suite must never touch a real store.** Every hook invocation in the tests should pass a temporary
  `RETRACE_DB`, and the suite should assert the default store is unchanged. That is the fix for finding 2.
- **"Credential-free" has to be checked, not assumed.** Retrace's own CLI creates a local key and store on first use;
  a machine that has run `retrace`, `retrace serve` or `npm test` is no longer empty.

## Limits

- **One machine, one evening, one operator.** AMD GPU; the Intel i915 crash (#21336) could not have reproduced here.
- **The agent that ran it is not a seat.** Its report is self-description, relayed by Jordan and then copied over ssh
  and hashed; the ledger holds the hash and this seat's reading of it, not the PC session's own events.
- **The update path and Route B were not exercised.** Whether Orca's self-updater acts on a package-managed install is
  unknown.
- **Orca's outbound connections at startup were seen, not attributed.** Telemetry was left at its default for Jordan to
  toggle (Settings → Privacy).
- **The AUR package is a third party's build.** The two hash checks tie this version to the vendor's release; they say
  nothing about the next version.

## Evidence

- **Ledger, the laptop seat:** prompt `evt_d746a30b…` (final `evt_f9cd8e4c…`), delivery verified `evt_f25dca09…`,
  report received and read `evt_b439d17b…`, store survey `evt_d2cd5349…`, finding `evt_ef92735d…`, deletion verified
  `evt_97f688af…`, ssh teardown `evt_b80e3cf7…`.
- **Local, on the operator's laptop and not in this repository:** the prompt, the send and fetch script, the PC
  session's `REPORT.md` and two notes with their sha256 values.
- **On the PC:** `~/orca-integration-2026-10-05/` (the report, the notes, the AUR checkout and the verified AppImage),
  the read-only clone, Orca's own state. `~/.retrace/` no longer exists there.
