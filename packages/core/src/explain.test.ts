import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEvent, roleMark } from "./explain.js";
import { Event } from "./schema.js";

const evt = (artifacts: Event["artifacts"]): Event =>
  ({
    id: "evt_0", project: "p", seq: 3, timestamp: "2026-08-25T00:00:00Z", received_at: "2026-08-25T00:00:00Z",
    actor: { type: "agent", id: "claude-code" }, action: "edited", artifacts,
    prev_hash: "0".repeat(64), hash: "f".repeat(64),
  }) as Event;

test("roleMark: in / out / in/out, nothing when unspecified", () => {
  assert.equal(roleMark("used"), "in");
  assert.equal(roleMark("generated"), "out");
  assert.equal(roleMark("both"), "in/out");
  assert.equal(roleMark(undefined), "");
});

test("describeEvent: artifact labels carry a role marker; role-less refs render exactly as before", () => {
  const line = describeEvent(evt([
    { id: "repo:x#a.ts", label: "a.ts", role: "used" },
    { id: "repo:x#b.ts", label: "b.ts", role: "generated" },
    { id: "repo:x#c.ts", label: "c.ts", role: "both" },
    { id: "repo:x#d.ts", label: "d.ts" },
  ]));
  assert.match(line, /edited a\.ts \(in\), b\.ts \(out\), c\.ts \(in\/out\), d\.ts$/);
  assert.equal(describeEvent(evt([{ id: "repo:x#d.ts" }])).endsWith("edited repo:x#d.ts"), true);
});
