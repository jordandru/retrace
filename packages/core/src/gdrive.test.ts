import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapDriveActivities, EventInput } from "./index.js";

const payload = JSON.parse(readFileSync(new URL("../test-fixtures/drive-activity.json", import.meta.url), "utf8"));

test("drive activity → events: actors resolved, co-editors split, kinds/urls, idempotency, ordering", () => {
  const evs = mapDriveActivities(payload);
  for (const e of evs) EventInput.parse(e);
  assert.deepEqual(evs.map((e) => e.action + (e.action_detail ? ":" + e.action_detail : "")), ["created", "other:shared", "edited", "edited", "sent", "created", "renamed:renamed", "deleted"]);
  const created = evs[0];
  assert.equal(created.project, "boxing-rpg");
  assert.equal(created.actor.id, "jordan@slcwitit.com"); assert.equal(created.actor.display_name, "Jordan Drumiler");
  assert.equal(created.artifacts[0].id, "gdoc:DOC1"); assert.equal(created.artifacts[0].kind, "doc");
  assert.equal(created.location?.url, "https://docs.google.com/document/d/DOC1/edit"); assert.equal(created.method?.tool, "google-docs");
  const edits = evs.filter((e) => e.action === "edited");
  assert.deepEqual(edits.map((e) => e.actor.id).sort(), ["coach.mike@slcwitit.com", "jordan@slcwitit.com"]);
  assert.equal(edits[0].duration_ms, 30 * 60000); assert.match(edits[0].intent!, /3 actions/);
  assert.notEqual(edits[0].idempotency_key, edits[1].idempotency_key);
  const comment = evs.find((e) => e.action === "sent")!;
  assert.equal(comment.actor.id, "coach.mike@slcwitit.com"); assert.match(comment.change!.summary!, /comment added/);
  const shared = evs.find((e) => e.action_detail === "shared")!; assert.match(shared.change!.summary!, /granted commenter to coach.mike@slcwitit.com/);
  const sheet = evs.find((e) => e.artifacts[0].id === "gdoc:SHEET1" && e.action === "created")!; assert.equal(sheet.artifacts[0].kind, "sheet"); assert.equal(sheet.method?.tool, "google-sheets");
  const del = evs.find((e) => e.action === "deleted")!; assert.equal(del.actor.type, "system"); assert.equal(del.method?.automated, true);
  const renamed = evs.find((e) => e.action === "renamed")!;
  assert.equal(renamed.artifacts[0].id, "gdoc:SHEET1"); assert.equal(renamed.artifacts[0].label, "Membership pricing model");
  assert.match(renamed.change!.summary!, /renamed "Untitled" → "Membership pricing model"/);
  // PROV role from the Drive verb: create → generated, edit/rename → both, comment/share → used, delete → absent
  assert.equal(created.artifacts[0].role, "generated");
  assert.ok(edits.every((e) => e.artifacts[0].role === "both"));
  assert.equal(renamed.artifacts[0].role, "both");
  assert.equal(comment.artifacts[0].role, "used"); assert.equal(shared.artifacts[0].role, "used");
  assert.ok(!("role" in del.artifacts[0]));
  // rename label comes from newTitle even when the queried target title is stale
  const rn = mapDriveActivities({ activities: [{ primaryActionDetail: { rename: { oldTitle: "Untitled", newTitle: "Fight plan" } }, actors: [{ user: { knownUser: { personName: "people/999" } } }], targets: [{ driveItem: { name: "items/D", title: "Untitled", mimeType: "application/vnd.google-apps.document" } }], timestamp: "2026-01-01T00:00:00Z" }] }, "p");
  assert.equal(rn[0].action, "renamed"); assert.equal(rn[0].artifacts[0].label, "Fight plan");
  // unresolved actor falls back to google:people/… id
  const un = mapDriveActivities({ activities: [{ primaryActionDetail: { edit: {} }, actors: [{ user: { knownUser: { personName: "people/999" } } }], targets: [{ driveItem: { name: "items/X", title: "x", mimeType: "application/vnd.google-apps.document" } }], timestamp: "2026-01-01T00:00:00Z" }] }, "p");
  assert.equal(un[0].actor.id, "google:people/999"); assert.equal(un[0].project, "p");
});
