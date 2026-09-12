#!/usr/bin/env node
/**
 * Phase A measuring instrument. Takes a retrace-export bundle and prints every
 * table in docs/design/step5-phase-a-measurement-brief.md §1 except the by-hand
 * conflicting review.
 *
 *   retrace-export export <project> --out /tmp/retrace-<project>.json
 *   node scripts/phase-a-measure.mjs /tmp/retrace-<project>.json
 *
 * Do not point this at the live API in a loop. The bundle is the input.
 *
 *   --since ISO --until ISO     restrict seal received_at to a window (Phase 1)
 *   --hook-log path             this machine's retrace-hook.log (per-machine)
 *   --pending-seal path         this machine's .git/retrace-pending-seal
 *   --json                      machine-readable MeasureReport
 *   --no-handshake              skip the in-process MCP tools/list census
 */
import { runCli } from "../packages/mcp-server/dist/phase-a-measure.js";

const out = await runCli(process.argv.slice(2));
process.stdout.write(out.endsWith("\n") ? out : out + "\n");
