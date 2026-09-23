# Omarchy clean-room trial, 2026-09-21/22 — partial measurement

**Status: INCOMPLETE.** Measurement, filed 2026-09-22 (MDT) as a dated partial record. The trial was stopped
mid-way at the operator's call. Measurement 3 is complete and measurement 6 is done for its clipboard half;
measurements 1, 2, 4 and 5 were never started. Nothing here answers the trial's question — can a stranger
install Retrace on a fresh Linux box and keep it honest? — because the install was never run. Measurement 1 is
added to this file, dated, when it runs.

**Provenance.** The trial was run by the `claude-code` seat in a second Claude Code session (model
`claude-opus-5[1m]`) under instruction `evt_3744ea457c1f4da491f956ce14dd1856`, briefed by the coordinator
(`evt_38d1cbcd0f8a464d961cba1e5e3c9c9b`), with Jordan operating the guest's keyboard. Its interim report was sent
to the coordinator as `evt_dba37fcf14ac4c8f9b7d155e46f3c53f` and verified on receipt
(`evt_3849708ade194d67960b05b079fa8a71`). This file is the coordinator's filing of that report, written by
`claude-code` on `claude-opus-5-5[1m]` on Jordan's instruction `evt_632f430f326c41029947e20809a3ac1e`.
**Class (b)** under agent-rules 12: it records what was measured and governs nothing. The rule change it
supports travels in its own class (a) pull request.

## The box

- **Omarchy 4.0.3-4** (kernel 7.2.6-arch2-1), terminal `foot`, shell bash, the vendor's instant trial account
  (passwordless sudo). A guest of **TryOmarchy.exe v0.0.20-preview** — the Windows trial app linked from
  omarchy.org, running QEMU on the Windows Hypervisor Platform. It is a prebuilt 4.0.3 image, not an install
  from the 4.0.4 ISO. Chosen because no spare machine or drive was available.
- TryOmarchy.exe was verified before it ran: sha256 matching the upstream release (`bef22fda…c6dd`), Authenticode
  signature valid, signed by an individual developer's identity-verified code-signing certificate that matches
  the top contributor of `omacom/try-omarchy-windows`.
- **Isolation was proved before any measurement** (`evt_1dcebc024f454cfdbe5d86ccea817ca5`): zero `RETRACE_*`
  variables and no `~/.retrace` in the guest. No credential, token or key entered the guest, and no Worker was
  contacted from it.
- For anyone reproducing: foot reports `TERM=xterm-256color`, so `TERM` misidentifies the terminal;
  `ps -o comm= -p $PPID` names it. `ls` is aliased to eza in the interactive shell.

## Findings

### F1 — A pasted markdown fence: inert on paste in foot, executes on Enter (measurement 3, complete)

Prediction sealed before the test: `evt_80150188aac24db38dc71d132c95ce9a`. Result:
`evt_ff7cbf84f3964c688f0ddf67e4d35af5`.

The bait was a three-line file: an opening fence, the line `echo PASTE-TEST-BODY-RAN`, and a closing fence. It
was copied inside the guest with `wl-copy` and pasted into foot with Ctrl+Shift+V.

- **On paste, inert.** The three lines arrived as literal text and nothing ran, even when key repeat delivered
  the paste twice. Bracketed paste held it for inspection.
- **On Enter, the body ran.** bash printed `bash: command not found: PASTE-TEST-BODY-RAN`. bash reads triple
  backticks as command substitution: the substitution opened by the third backtick swallows the echo line, the
  closing fence runs it, and its output becomes the command word. The error naming the marker is the proof that
  the echo ran.

Set beside the incident rule 16 cites (2026-09-21T02:28Z, `evt_6bfe5f181c1446579d20dfab4147bba0`: a human paste
from a desktop chat app into Jordan's terminal):

| | 02:28Z, Jordan's terminal | 2026-09-22, foot on Omarchy |
|---|---|---|
| on paste | executed: nested shells spawned | inert, held as literal text |
| when the bodies ran | later, on each `exit`, unnoticed | on Enter, once, visibly |
| damage | a real `wrangler secret put` and a `shred -u` | one `command not found` |

Same bait, same shell, different outcomes. The difference is the receiving terminal's paste mode, and the
sender cannot see it. So rule 16's instruction — never hand Jordan a fenced code block to paste into a terminal
— stands as written, and now has a second machine behind it.

**Hypothesis history, kept.** The trial seat first read the 02:28Z pattern (nested shells, bodies on `exit`) as
programmatic injection into a pane, which would have meant rule 16 was aimed at the wrong actor. It labelled
that a hypothesis and named the evidence that would settle it. Reading `evt_6bfe5f18` on 2026-09-22 falsified
it: a human paste, no tool involved. The sealed prediction and result events call it a hypothesis in their own
text and stay accurate.

**A related instance**, recorded because it happened while the report was being written: an unquoted heredoc
delimiter made bash run every backticked word inside the heredoc as command substitution (a `mktemp` ran, and
its temporary path landed in the prose). Same mechanism, no paste involved.

### F2 — The clipboard is an on-disk, cross-machine sink that survives clearing (measurement 6, clipboard half)

Events: `evt_df0a274b0e094052a3795e1f6e3468e9`, `evt_9bf2c15108c54f818f6db243ef55c73e`,
`evt_fcf5f5a8be8b497fafde796ea90e0683`.

Two independent watchers read the same Wayland clipboard in the guest:

- **Omarchy's clipboard history** — `quickshell`, with `wl-paste --watch` running
  `/usr/share/omarchy/shell/plugins/clipboard/capture.sh` for text and PNG. An Omarchy default ("Unified
  Clipboard & History", Super+Ctrl+V).
- **TryOmarchy's host bridge** — `/usr/local/bin/clipboard-bridge`, with push watchers on text, PNG,
  `text/uri-list` and `x-special/gnome-copied-files`, plus a `file-transfer clipboard-pull` daemon. Injected by
  the VM app, not part of Omarchy.

Measured:

- `wl-copy --clear` does not clear the history.
- Text and images copied on the Windows host appear in the guest's history with no action taken in the guest.
  Guest-to-host also works.
- The history is on disk: text in `~/.local/state/omarchy/clipboard-history.json`, images in
  `~/.local/state/omarchy/clipboard-images/` — 948 KB at the time, three PNGs, all of them screenshots taken on
  the Windows host during the session.
- Deleting the text file is not remediation. The running shell recreated it within seconds and kept capturing.
  The delete did remove what was on disk: the recreated file held only later entries. Stopping the capture
  daemon or shutting the guest down is the remediation.
- Host-origin entries carry CRLF line endings; guest-origin entries carry LF. An auditor can tell which entries
  crossed the machine boundary.
- Copying a command's output out of the terminal to report it writes that output into the history.

Rule 16 names three sinks: agent transcripts, a pane's environment, and the clipboard. This measures a further
shape of the clipboard sink: a history that survives a clear and is fed automatically from another machine.

**Credit.** `capture.sh` records nothing when the selection is marked sensitive (`CLIPBOARD_STATE=sensitive`) or
the source advertises `x-kde-passwordManagerHint`, so a password-manager copy that sets the hint is not
captured. The guard depends on what the source advertises, and a terminal, an ordinary editor and the bridge
advertise nothing. **Hypothesis, not measured:** the bridge does not carry Windows' clipboard-history exclusion
into the Wayland hint, so a secret copied on the host would bypass the guard. The test that settles it: copy
from a Windows app that excludes its content from clipboard history, then check the guest's history.

**Permissions.** `clipboard-history.json` is mode 0644 (world-readable); each image is 0600. Cause, measured:
with umask 0022 a file created without an explicit mode is 0644, and the images get 0600 from `mktemp`. An
omission, not a choice — and the text file is the likelier carrier of a copied secret. Whether another account
can actually reach the file also depends on the home directory's mode, which was not measured.

### F3 — Declining the shared folder does not close the host–guest file channel

The bridge's `--push-files` watchers and the `file-transfer clipboard-pull` daemon carry files through the
clipboard, in both directions, with no shared folder mounted. Declining the folder at launch removes a mount,
not the channel. This corrects the trial's own launch instruction, which presented declining the folder as
closing the file channel.

### Other observations

- **Signature chain — the trial reported two gaps; one is withdrawn on filing.**
  - *ISO, withdrawn.* The trial noted that the ISO's `.sha256` is served from the same host as the ISO (transfer
    integrity, not authorship) and that no public key for its `.sig` was named on the pages it read (the download
    block and six manual pages). That observation was true of those pages, but the key is published: the
    manual's Security page names the fingerprint for all ISO and package signatures,
    `40DFB630FF42BCFFB047046CF0134EE680CAC571`, and the `omarchy-keyring` package carries it. Found on 2026-09-22
    while checking before an upstream report. There is no gap in the chain; at most, the download block's
    signature link does not point to the key.
  - *TryOmarchy.exe, stands, narrowed.* The project documents its signing pipeline (`docs/RELEASING.md`: Azure
    Artifact Signing through GitHub OIDC, Authenticode verified before upload, and a separate Ed25519 key pinned
    in the launcher for update manifests). What no page states is the Authenticode publisher a first-time
    downloader should expect. The release checked was validly signed by an identity-verified individual whose
    name matches the repository's top contributor, but that match rests on GitHub history, not on a published
    statement of who signs.
- **Shutdown.** Closing the TryOmarchy window did not shut the guest down. Shutdown from inside Omarchy
  (Super+Space > System > Shutdown) did, verified from the host by the absence of any TryOmarchy or QEMU
  process. While the guest runs, the bridge is live (F2, F3).
- **Focus.** With the TryOmarchy window focused, Win+Shift+S reached the guest as Super+Shift+S and triggered
  guest bindings instead of the Windows snipping tool — a property of TryOmarchy's focus model.

## Rule table (agent-ops 1–16) — only what was measured

| rule | measured | result |
|---|---|---|
| 16 terminal boundary | yes | the fence hazard confirmed on a second machine (F1); two further sink shapes (F2, F3) |
| 11 doctor flakes on WSL2 fetch timeouts | on the laptop only | a `retrace_log` returned `fetch failed` during the trial and succeeded on retry; not tested on the guest |
| 1–10, 12–15 | no | not started |

## Not done

- **Measurement 1** — the stranger install of `@retrace-dev/cli@0.1.9`: doctor, `retrace-git install`, commits,
  seal, export, verify, the MCP handshake, timings, and whether the 2026-09-20 dry run's findings reproduce at
  0.1.9. Not started; the largest part of the trial.
- **Measurement 2** — Omarchy's git config (`core.hooksPath`, `init.templateDir`, `commit.gpgsign`).
- **Measurement 4** — a `systemd --user` timer across logout and reboot with lingering enabled.
- **Measurement 5** — the full rule-by-rule table.
- **Open:** does the clipboard history survive a reboot; is there a wipe that empties it; does the bridge carry
  sensitivity flags.
- **Standing hypothesis, not settled.** Node on Omarchy comes from mise. Is `node` on `PATH` in the
  non-interactive shell a git hook runs in? The interactive `PATH` carries mise's node install directory as a
  real directory, and `PATH` is inherited by child processes, which weakens the concern. Only installing the
  hook and committing settles it (measurement 1).

## Resuming

The guest's disk persists (TryOmarchy keeps it under `%LOCALAPPDATA%\TryOmarchy`), so the guest relaunches with
its state. The trial folder holds a runbook with screens 3–8 ready for measurement 1. While the guest runs,
anything copied on Windows is written into its clipboard history (F2): shut it down from inside before any
secret-bearing work on the laptop.

## Evidence

Sealed: the events cited above. Local, and not in this repository: the trial folder
`~/.retrace/omarchy-2026-09-21/` on the operator's laptop — `REPORT.md` (interim), `PLAN.md`,
`omarchy-facts.md`, `guest-runbook.md`, and `logs/` (`measurement3-paste-hazard.log`,
`clipboard-architecture.log`, `screen1-box-identity.log`, and the exact text sent to the coordinator).
