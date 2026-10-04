# OpenShell Stage 1 on the Omarchy PC, 2026-10-03/04 — credential-custody pilot, measurement

**Status:** measurement, class (b) under agent-rules 12. It records what was measured and governs nothing. Filed
2026-10-04 by pull request on Jordan's signed go `evt_bb996a2e…`. The working files (the plan, the run plan, every
script and one log per command) are in the operator's local folder and are not in this repository.

**Provenance.**
- **Who ran it:** the `claude-code` seat in a second Claude Code session (`claude-opus-5-5`, source `harness-runtime`),
  over ssh to the Omarchy PC of `docs/measurements/omarchy-bare-metal-2026-10-02.md`.
- **The plan:** Stage 1 of the OpenShell plan saved on Jordan's signed instruction `evt_d182ae0f…`; the PC was chosen
  as host in `evt_06c17bd7…`. Stage 1 is the credential-custody pilot, candidates B and D of the 2026-10-01 research
  report (`evt_3bd81e05…`). Each step ran on its own go.
- **Gos, all JD-signed:**
  - Jordan raised the work: `evt_dec0a7c8…`
  - go 1, the host: `evt_2573ac10…`
  - go 2, the install and the credential-free checks: `evt_a9aed234…`
  - go 2b, the swap check and test 5: `evt_c8c3b0a6…`
  - Option S for test 4: `evt_12cd0d46…`
  - the runs: `evt_d77660d5…` and `evt_2c4f63ca…`

## Verdict

**Yes for the sandbox; no for the host account.** NVIDIA OpenShell v0.1.2 on rootless Podman kept a Retrace bearer
token out of a sandboxed agent's reach, and a Retrace server still recorded who acted:
- The sandbox only ever held a placeholder (`openshell:re…`). No value in its environment hashed to the token.
- The proxy swapped the placeholder for the token only at the endpoint the token is bound to. Anywhere else it refused
  with `credential_endpoint_mismatch`.
- A call authorised only by the placeholder was sealed by a scratch Retrace server under the pinned identity
  `openshell-pilot`, acting for the owner.

**The limit:** OpenShell stores the token encrypted, under a key file in the same Unix account. Any host process running
as that user can read it, including an AI agent signed in on the PC itself. OpenShell guards against the sandbox, not
against the host account.

Tests 1, 2, 3 and 5 used fake tokens. Test 4 used a scratch token on a scratch server. **The production Worker was never
contacted, and no production credential was created** (see Limits).

## The box and the install

| | measured |
|---|---|
| host | the Omarchy 4.0.4 PC of the 2026-10-02 trial. Kernel 7.2.5-3-omarchy; LSMs `lockdown,capability,landlock,yama,bpf`; **Landlock ABI 10**; cgroup v2; user namespaces on. User `stranger`, not in `docker`; subuid and subgid 100000:65536. |
| runtime | **Podman 6.1.1** from Omarchy's package snapshot: rootless, runc, netavark, pasta. OpenShell documents and qualifies **Podman 5.x** only. Docker 29.7.2 is installed but unused: `compute_driver = "podman"`. |
| OpenShell | **v0.1.2** CLI and gateway, from the release tarballs. sha256 checksums OK. `gh attestation verify` OK for both: SLSA provenance v1, signer `release-tag.yml@refs/tags/v0.1.2`, source commit `6648bd0c290e` (`evt_3eea1e18`). |
| gateway | a `systemd --user` unit adapted from the release's `deploy/deb` unit, with the binaries in `~/.local/bin`. TLS with client certificates on `127.0.0.1:17670`. `OPENSHELL_TELEMETRY_ENABLED=false`, read back from the running process (`evt_59627ced`). |
| sandboxes | default workload image `nvcr.io/nvidia/base/ubuntu:24.04`, which has perl only (no python3, curl or wget). Supervisor `ghcr.io/nvidia/openshell/supervisor:0.1.2`. About 140 MB downloaded in all. |

## Results

| # | test (Stage 1 plan) | result | evidence |
|---|---|---|---|
| 1 | Landlock ABI ≥3 from inside the sandbox | **PASS.** ABI 10 inside. Reads of `/opt`, `/srv`, `/home` and `/var/lib` (DAC 755) were denied, as were writes to `/var/tmp` and `/dev/shm` (DAC 1777), although DAC allows them. NoNewPrivs 1; seccomp filter mode with 6 filters; no effective capabilities. | `evt_fe1baad0` |
| 2 | `env` shows only the placeholder | **PASS**, with a fake token and with a scratch token. The variable held an `openshell:re…` placeholder of 62–65 characters. No environment value hashed to the token. | `evt_9751dd20`, `evt_0af2013c` |
| 3 | the placeholder sent to another host gets `credential_endpoint_mismatch` | **PASS.** example.com is allowed by network policy but not bound to the token. Result: HTTP 403 `credential_endpoint_mismatch`. OCSF logged `HTTP:GET [HIGH] DENIED … engine:credential-binding` and `FINDING:BLOCKED [HIGH] … endpoint_mismatch`, with no URL, placeholder or value in either record. The same request without the placeholder got 200. | `evt_3820bd45`, `evt_0af2013c` |
| 4 | a Retrace server seals the call under the new credential | **PASS, Option S.** A scratch `retrace-serve` (`@retrace-dev/cli@0.2.0`) ran on the PC with one pinned, keyless agent credential for `openshell-pilot`, project `openshell-pilot`. A POST from the sandbox carrying only the placeholder got **201**. The scratch ledger holds event `evt_cb266d8b…`: actor `agent openshell-pilot` on behalf of the owner, stamped `pinned:openshell-pilot · … (SCRATCH)`, with no producer signature (keyless by design). Without the header: 401. | `evt_0af2013c` (run 1: `evt_c930dfc4`) |
| 5 | a gateway restart mid-run gives an explicit loss signal | **PASS.** Restarting the gateway stopped and restarted every sandbox (the same two containers), killing the processes inside. The gateway logged "Stopped sandbox during gateway shutdown". The ten requests before the restart all carried the swapped value, none ran during it, and no request went out with an unresolved placeholder. | `evt_b87a9a78` |

**The swap itself (go 2b).** A second fake token, bound to an echo endpoint (httpbin.org), came back exactly as stored:
`sha256("Bearer " + value)` matched. All the while, the sandbox held only the placeholder (`evt_b87a9a78`).

**Run 1 of test 4 failed on this seat's client, not on OpenShell or Retrace.**
- The event body lacked `actor`. The 0.2.0 event schema requires it even for pinned credentials; the server then stamps
  the credential's own actor.
- The request was already authenticated: it got 400, not 401. So the swap had worked.
- The client was fixed, and test 4 was re-run on Jordan's go.

## Observations (not Retrace defects)

1. **OpenShell's Podman config example omits `[openshell] version = 2`.** The v0.1.2 gateway refuses to start without
   it (`config preflight … category=missing_version`).
2. **There is no installer path for Arch-based systems.** `install.sh` installs only deb, rpm or snap, and the snap
   needs Docker Engine. On Omarchy, the install was the release tarballs plus a hand-made user unit.
3. **Podman 6.1.1 worked for everything measured,** although only 5.x is documented. The driver calls the libpod API
   with a `v5.0.0` prefix; Podman 6.1.1 accepts it (MinAPIVersion 4.0.0).
4. **The proxy keeps a client connection open after a complete response,** even for `Connection: close`. A client with
   no read timeout waits forever; this stalled one control run.
5. **The custody boundary is the Unix account.** By default, OpenShell encrypts stored credentials in its database
   under a key-encryption key at `$XDG_STATE_HOME/openshell/gateway/credentials/key-encryption-key.bin` (owner-only).
   Any process of that user can decrypt them.
6. **`host.openshell.internal` maps to 127.0.0.1 on rootless Podman,** with a warning
   (`trusted-gateway SSRF exemption disabled ip=127.0.0.1`). The provider-generated policy still allowed the call to
   the host service.
7. **A gateway restart does not keep sandboxes running.** It stops them on shutdown and starts them again
   (`recovered=false`), so in-flight work is lost, though not silently.

## What this means for Retrace

- **Candidate B holds at the sandbox boundary.** An agent inside an OpenShell sandbox can act under a pinned Retrace
  identity without ever holding the token, and the ledger still records the pinned actor. This addresses agent-ops 16's
  credential sinks (tokens in agent environments and transcripts) at the runtime rather than by procedure.
- **It does not close the host-account sink.** The token sits encrypted beside its key in the same account, and a
  host-level agent running as that user can read it.
- **Production use needs a keyless pinned identity, and none can be minted for a new name today.**
  - The Worker's `/mcp` accepts only pinned, single-project agent credentials without `require_signature`
    (`apps/worker/src/mcp.ts`).
  - `retrace-admin` mints a keyless agent credential only for `openclaw` (`packages/mcp-server/src/admin.ts`).
  - So a production pilot needs a class-(a) change and an agent-rules 7 exception: the same shape as the cloud-seat
    design's steps B2 and B6. That is Stage 2's question (Option P), and it is not decided.

## Limits

- **No production credential and no production Worker.** Tests 1–3 and 5 used fake tokens; test 4 used a scratch token
  on a scratch `retrace-serve`. The Worker's remote `/mcp` route was not exercised; the client used the REST
  `POST /events`.
- **One host, one operator, two days.** The runtime was Podman 6 (undocumented), installed by an unofficial path.
- **Plain HTTP only.** The test client was perl without TLS, so the TLS-intercepting path to HTTPS endpoints was not
  measured.
- **OpenShell's own audit is best-effort and unsigned** (2026-10-01 research report). Its OCSF records above are
  observations, not Retrace evidence.
- **The swap test sent a fake value to a third-party echo service.** That is acceptable only with fake values: a real
  token must never meet an echo endpoint.

## Evidence

- **Ledger, this seat:**
  - Stage 0: `evt_c85ab6db`
  - PC survey: `evt_5bb4e0e3` (correction `evt_3c28b665`)
  - release download and attestations: `evt_3eea1e18`
  - gateway: `evt_59627ced`
  - tests: `evt_fe1baad0`, `evt_9751dd20`, `evt_3820bd45`, `evt_b87a9a78`
  - go-3 proposal: `evt_3c93eddf`
  - test 4 runs: `evt_c930dfc4`, `evt_0af2013c`
  - SSH access closed after each session: `evt_7834f0ec`, `evt_8e61df73`
- **Local, on the operator's laptop and not in this repository:** the plan, the run plan, every script with its sha256,
  and one log per command.
- **On the PC:** the scratch ledger and the sealed scratch event.
