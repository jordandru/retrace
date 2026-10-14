# The Omarchy PC incident of 2026-10-08: the second cursor was a recording — measurement

**Status:** measurement, class (b) under agent-rules 12. It records what was measured and governs nothing. Filed
2026-10-14 by pull request on Jordan's signed instruction `evt_872ab2c1ef8b40a48adbb005b3d35845` ("Omarchy pane writes
the Oct 8 incident note; Codex reviews"), routed by Coordinator 34 (`evt_f6ce9efc28424436b2c2dbe1ef365ba5`). The working
records it is written from (the revival plan, the decision record, the hand-offs, the repair record) and the evidence
images stay in the operator's local folder and are not in this repository. Section 9 cites each by sha256.

**Provenance.**
- **Who investigated:** the `claude-code` seat on the laptop, in several sessions from 2026-10-10 to 2026-10-14.
  Jordan sat at the PC for every PC-side step, and the repair's changes on the PC were made by him at its keyboard. A
  Claude Code session on the PC (not a Retrace seat: no credential, no ledger) ran read-only reads that Jordan typed and
  carried back.
- **Who wrote this:** the `claude-code` seat, Omarchy Orchestrator pane (session `0a4c0b09…`, model `claude-opus-5-5`,
  source `harness-runtime`).
- **Times** are MDT (UTC−6). UTC is given where the record is in UTC.

## Verdict

**The "second cursor" was a video.** At 8:30 PM on 2026-10-08 an Omarchy community plugin, Motion Wallpaper, was
installed from the PC's own keyboard. Jordan believes he did it, though in his own recollection that is uncertain. At
8:48 PM the plugin began looping a 4.9-second, full-screen screen recording as the desktop background, behind every
window. The recording, made on that PC at 3:53 AM on 2026-10-05, shows Orca with a cursor
moving and clicking. Nothing found points to another person, device or agent controlling the PC.

## What was seen

Jordan's account, given 2026-10-12 (`evt_af736fe0…`), is Jordan-reported and in his own words uncertain: the cursor
"was moving around in the Orca app. I shut the PC off. When I turned it back on (after logging into Stranger), Orca was
still open (non-responsive), and it seemed the cursor was still moving, and had potentially clicked on elements in the
page (Orca layout/tabs appeared different than how I left them)." He removed the PC from the tailnet and kept it off
until a guided repair session on 2026-10-13.

## Timeline, 2026-10-08

Sources: the PC's persistent journal, bash history and file list (read on 2026-10-11 and 10-12), and Jordan's
recordings and photo (2026-10-14).

| MDT | UTC | Event | Source |
|---|---|---|---|
| 8:30 PM | 02:30 (10-09) | `omarchy plugin add …Motion-Wallpaper-Omarchy.git --enable` typed at the keyboard | bash history, journal |
| 8:48:00 PM | 02:48:00 | the shell opens `~/Videos/screenrecording-2026-10-05_03-53-28.mp4` (4.90 s, 3840x2160) as the looping wallpaper | journal |
| 8:53:28 PM | — | a 78-second recording of a 408x268 region of the screen (Jordan's, Jordan-reported) | file list |
| 8:56:34 PM | — | a 2 min 18 s recording of the screen (Jordan's, Jordan-reported) | file list; frames below |
| 8:57 PM | — | phone photo: the real Orca's "Close Window?" dialog with Jordan's cursor on Close, and a second cursor at the top edge of the screen | image #19 |
| 8:57:09–11 PM | 02:57:09–11 | Chromium, one other app and the Orca app exit within 2 s | journal |
| about 8:57:27 PM | — | frame at 0:53 of the 8:56:34 recording: "Orca" with its "+" menu opening while Jordan's cursor is in Omarchy's menu | image #18 |
| 8:59:21 PM | 02:59:21 | restart requested from the desktop session | journal |
| 9:09:47 PM | 03:09:47 | in the next boot the wallpaper plays the 8:53 PM region clip; no Orca app runs in that boot | journal |
| 9:18 PM | — | Jordan removes the PC from the tailnet | Jordan-reported |

## Cause and evidence

1. **The mechanism is on record.** The plugin was added at the keyboard at 8:30 PM, and at 8:48:00 PM the journal shows
   the shell opening the 2026-10-05 recording as the background. Its code (read on 2026-10-11) stats files, scans
   `~/Videos`, queries the window manager and probes the video decoder. It injects no input and makes no network call.
2. **The repair session confirmed it (2026-10-13).** At boot the background played a recording with a cursor that moved
   and clicked in Orca. After `omarchy plugin remove nosignal.motion-wallpaper` the cursor was gone (Jordan-reported).
3. **Jordan's recordings from the night confirm it (2026-10-14).**
   - Image #18 is the frame at 0:53 of the recording started at 8:56:34 PM, so about 8:57:27 PM. It shows an Orca window
     with its new-tab menu opening while Jordan's live cursor sits in Omarchy's menu.
   - The journal shows the Orca app exiting at 8:57:09–11 PM, 16 seconds earlier. After that no Orca window existed, so
     the "Orca" in that frame is the background video.
   - Image #19, a phone photo taken at 8:57 PM, shows the real Orca's quit dialog with Jordan's cursor on Close. A second
     cursor shows at the top edge of the screen, where the background shows through.
   - The Orca content in the frames is the 2026-10-05 install session, which matches the recording's date.
   - Jordan has since watched the 4.9-second clip himself (`evt_f2863ae542954a51a8cf234bdea15823`).
4. **Whose cursor.** The ledger shows Jordan working on the Omarchy Orca setup at 3:55 AM MDT on 2026-10-05 (his
   instruction at 2026-10-05T09:55:48Z), two minutes after the recording's time stamp. So the recorded cursor was most
   likely his own. That is not proven.

## Other explanations, checked

- **A stranger on the tailnet: excluded.** In the whole boot there were two tailnet peers, the laptop and Jordan's phone.
  All ssh contact came from the laptop, using the laptop's own key, which had been added at the PC's keyboard minutes
  before. The firewall logged no accepted inbound connection from any other address.
- **Software that is not Omarchy's: excluded.** `pacman -Qkk` was clean for binaries and units. The package log is
  explained, and no unexplained unit, timer, autostart entry or hook was found.
- **A hardware or input device: no evidence.** No new input device appeared on 2026-10-08.
- **An Orca remote client: no evidence.**
  - Orca's mobile app can change Orca's tabs and panes remotely, but it cannot move the system pointer.
  - The PC's Orca logs show no remote or device activity between 8:40 and 9:00 PM: 114 trace records, all routine git
    polling and memory notes, and in the daemon log only the shutdown.
  - The logs' only device-tagged records that day are tab closes by two devices between 2:33 and 3:55 PM. Jordan was then
    working from the laptop (`evt_e2e8a463eed64fdf8f68c64d3c7d5a48`).

## Not established

- **Who made the 2026-10-05 recording.** Most likely Jordan, as above.
- **What used the PC's Orca access grant at 8:48 PM, its "last used" time.** The laptop's own Orca logs show it
  installing an update and relaunching at 8:48:04 PM (`evt_4debe2d0981347969b53e14035c1d163`), with the PC saved as a
  server. That is the likely explanation, but Orca logs no connections, so the PC's logs cannot confirm it. The grant
  has since been revoked.
- **Two edited files in the PC's read-only clone** (a router source file and its test), changed that afternoon. Most
  likely an agent Jordan ran there; no ledger event covers them.

## Corrections to the working records

These correct the local records, not this repository: none of the refuted statements appears in `docs/`.
- **"The 2026-10-07 and 10-08 boots unlocked the disk by themselves" is refuted.** The inference rested on journal
  timestamps, and the journal stamps early kernel lines after the unlock. The one boot screen is the LUKS passphrase
  prompt. There is no keyfile, and the disk is encrypted at rest (`evt_aa941ca5…`, assessment `evt_fc8efc9d…`).
- **"Something turned automatic login off" is wrong.** Automatic login (SDDM) is on, and the one password screen is the
  disk's.
- **The investigating pane's own errors**, corrected on the ledger at the time: it called the boot screen settled too
  early (`evt_02156949…`), and it misjudged which server a "needs authentication" notice referred to.

## Repair and hardening (2026-10-13 and 10-14)

- The plugin and its leftovers were removed.
- The file-sharing (LocalSend) firewall rule now admits only the tailnet and the home LAN.
- The PC's `authorized_keys` holds one key, and sshd accepts keys only (checked 2026-10-14).
- The PC rejoined the tailnet as a fresh node, and the only access rule that reaches it is ssh from the laptop.
- Orca remote access is off on every device: the access grant revoked, the mobile pairings removed, and the laptop's
  saved server deleted.
- Claude's claude.ai connectors are disabled on the PC.
- The accounts behind the PC's remote access were reviewed and tightened. The record stays in the operator's folder.

## Lessons

- **A screen-recording wallpaper reproduces a moving, clicking cursor exactly.** When a "second cursor" appears, check
  the background layer first. A loop repeats exactly: here, every 4.9 seconds.
- **Journal timestamps cannot show a passphrase wait at boot.** Use `systemd-analyze` or a boot's "Startup finished"
  line.
- **Keep the recordings made during an incident.** Jordan's own screen recordings, found days later, settled the cause
  from the night itself.

## Sources

Local working records, in the operator's folder `~/.retrace/omarchy-revival-2026-10-10/` (not in this repository):

| Record | sha256 |
|---|---|
| `REVIVAL-PLAN.md` | `c608f812fce70e2ec26a7ea832b67a7d3d026bf843772949f92c7eeef5be7858` |
| `R3-DECISION-2026-10-11.md` (timeline, hypotheses, plugin code read) | `64e4918ca276d5e08a8bc3150c6740eb29e5725e40ebbd12a462d1464ca39c9d` |
| `HANDOFF-R4-ADDENDUM-1-2026-10-12.md` (Jordan's account, the 8:48–9:10 PM journal) | `1f4913069bf3448edd1e443a14cb9554016b67f01b53ce612707264d940b0bb2` |
| `R4-REPAIR-SESSION-RECORD-2026-10-13.md` | `c09d279a67ed64e56578330c3e688c3da3d515eb4fb360d1281fe2b6b2d38f8f` |
| `HANDOFF-OMARCHY-ORCHESTRATOR-2026-10-14.md` | `3b2819359b8876a4355986e9d8189c5dfc5eee54b825786812926aaf150a0670` |
| `R1.6-ACCOUNT-REVIEW-RECORD-2026-10-14.md` | `f72d2bab8596b961df974fe9785a5ffda0048c37dd2d3c12db03fd94c67997a4` |
| `evidence-2026-10-14/SHA256SUMS` (the six images below) | `1f510babe87b405d6d66e7c124dc6f100fb11f5ffbcb82c5cecb8b4943608911` |

The images, sealed with Jordan's messages (`evt_13df2fc7591b46de9d2aa6ae432e7a88` for #14–#18,
`evt_f2863ae542954a51a8cf234bdea15823` for #19). They are not in this repository:

| Image | What it shows | sha256 |
|---|---|---|
| #14 | 8:56 PM, frame: Orca's new-tab menu open | `0d531f22b2a6c759a2ded8ce087b5133bb6f6fe6faf8685086689f82eecfe188` |
| #15 | 8:56 PM, frame: Orca, no menu | `910331866e7635b1e02f091fc3783cd4467fa5fcd17c0665e0996540e0712871` |
| #16 | 8:57 PM, frame: Orca's new-tab menu open | `71f10a3b83737651a9c406aeeda879d08176fe1e373fc5d2540fdf1702fe85c5` |
| #17 | 8:57 PM, frame: Omarchy's menu with Jordan's cursor | `51aa53733816b74f36d6db9c184da46a3d81e263a35e8360370264fb290566a3` |
| #18 | 8:57 PM, frame at 0:53 of 2:18: Omarchy's menu over "Orca" with its menu open | `4a520c1d4abc590108a575e24da2f4840654479e06a71345a2a54f43d4d93a01` |
| #19 | 8:57 PM, phone photo: the real Orca's quit dialog; a second cursor at the top edge | `dc0901bc0f23dac57ebf10a6c6bb52ac57c783efce76a104ad88519d9d83c8c1` |

Ledger events: the frame assessment `evt_2e2ca46bb7204bc5ba4dab16c0dca537`; Jordan closing the question
`evt_969fa870575c4cb68fc748eada85baf8`; the PC's Orca log reads `evt_2d36ec36ce1e41b1b8f5d5336ec5cb0d` and
`evt_8dbb67ea3b3f4b508d65d2080af5d033`; the account review record `evt_5f09a679fe77431a82c37f2dd79feb75`.
