import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchPrincipalConflicts,
  boundPrincipals,
  formatPrincipal,
  parseActorRef,
  parsePrincipalRef,
  projectIssuanceStatus,
  refuseReissueIfBound,
  refuseSetPrincipalIfConflict,
  sharedLivePinnedActorIds,
  type IssuanceCredential,
} from "./credential-status.js";

const alice = { type: "human" as const, id: "alice@acme.dev" };
const bob = { type: "human" as const, id: "bob@acme.dev" };
const cred = (over: Partial<IssuanceCredential> & Pick<IssuanceCredential, "actor">): IssuanceCredential => ({
  trust: "pinned",
  projects: ["acme"],
  ...over,
});

test("parsePrincipalRef / parseActorRef accept ids that contain slashes", () => {
  assert.deepEqual(parsePrincipalRef("human/alice@acme.dev"), alice);
  assert.deepEqual(parsePrincipalRef("team/acme"), { type: "team", id: "acme" });
  assert.throws(() => parsePrincipalRef("agent/codex"), /human\/<id> or team\/<id>/);
  assert.deepEqual(parseActorRef("agent/codex"), { type: "agent", id: "codex" });
  assert.deepEqual(parseActorRef("system/retrace-git-acme"), { type: "system", id: "retrace-git-acme" });
});

test("T21: shared_actor_id lists live pinned collisions only", () => {
  const creds: IssuanceCredential[] = [
    cred({ actor: { type: "agent", id: "codex" }, principal: alice }),
    cred({ actor: { type: "agent", id: "codex" }, principal: bob }),
    cred({ actor: { type: "agent", id: "gemini" }, principal: alice }),
    cred({ actor: { type: "agent", id: "codex" }, retired_at: "2026-09-01T00:00:00Z", principal: alice, name: "retired" }),
    cred({ actor: { type: "agent", id: "codex" }, trust: "assert", principal: alice, name: "hook-shaped" }),
    cred({ actor: { type: "agent", id: "codex" }, principal: bob, projects: ["other"] }),
  ];
  assert.deepEqual(sharedLivePinnedActorIds(creds, "acme"), [{ type: "agent", id: "codex", count: 2 }]);
  assert.deepEqual(sharedLivePinnedActorIds(creds, "other"), []);
});

test("issuance reports principal: missing and never guesses", () => {
  const creds: IssuanceCredential[] = [
    cred({ actor: { type: "agent", id: "codex", on_behalf_of: "alice@acme.dev" } }),
    cred({ actor: { type: "agent", id: "gemini" }, principal: alice }),
  ];
  const status = projectIssuanceStatus(creds, "acme");
  assert.equal(status.principals[0]!.principal, "missing");
  assert.deepEqual(status.principals[1]!.principal, alice);
});

test("T29: refuseReissueIfBound names the original principal; same principal is allowed; missing history blocks reissue", () => {
  const actor = { type: "agent", id: "codex" };
  assert.equal(refuseReissueIfBound([], "acme", actor, bob), undefined);
  const retiredAlice = cred({ actor, principal: alice, retired_at: "2026-09-01T00:00:00Z" });
  assert.equal(refuseReissueIfBound([retiredAlice], "acme", actor, alice), undefined);
  const refused = refuseReissueIfBound([retiredAlice], "acme", actor, bob);
  assert.match(refused!, /originally bound to human\/alice@acme\.dev/);
  assert.match(refused!, /human\/bob@acme\.dev/);
  assert.equal(formatPrincipal(alice), "human/alice@acme.dev");

  const missing = cred({ actor: { type: "agent", id: "codex", on_behalf_of: "alice@acme.dev" } });
  assert.deepEqual(boundPrincipals([missing], "acme", actor), []);
  assert.match(refuseReissueIfBound([missing], "acme", actor, bob)!, /have no principal/);
  assert.match(refuseReissueIfBound([missing], "acme", actor, alice)!, /set-principal/);
  assert.match(refuseReissueIfBound([missing], "acme", actor, bob)!, /do not guess from on_behalf_of/);

  const conflict = [
    cred({ actor, principal: alice, retired_at: "2026-09-01T00:00:00Z" }),
    cred({ actor, principal: bob, retired_at: "2026-09-02T00:00:00Z" }),
  ];
  assert.match(refuseReissueIfBound(conflict, "acme", actor, alice)!, /human\/alice@acme\.dev, human\/bob@acme\.dev/);
});

test("historicalPrincipalConflicts stay visible after the original holder is retired", () => {
  const actor = { type: "agent", id: "codex" };
  const retiredAlice = cred({ actor, principal: alice, retired_at: "2026-09-01T00:00:00Z", name: "alice-codex" });
  const liveBob = cred({ actor, principal: bob, name: "bob-codex" });
  const status = projectIssuanceStatus([retiredAlice, liveBob], "acme");
  assert.deepEqual(status.shared_actor_id, []);
  assert.equal(status.principal_conflicts.length, 1);
  assert.deepEqual(status.principal_conflicts[0]!.actor, actor);
  assert.deepEqual(status.principal_conflicts[0]!.principals, [alice, bob]);
  assert.equal(status.principal_conflicts[0]!.live.length, 1);
  assert.equal(status.principal_conflicts[0]!.live[0]!.principal, bob);
});

test("batchPrincipalConflicts refuses two principals for one actor id in a first batch", () => {
  const planned = [
    cred({ actor: { type: "agent", id: "codex" }, principal: alice }),
    cred({ actor: { type: "agent", id: "codex" }, principal: bob }),
  ];
  assert.match(batchPrincipalConflicts(planned, "acme")!, /multiple principals in this batch/);
  assert.equal(batchPrincipalConflicts([cred({ actor: { type: "agent", id: "codex" }, principal: alice })], "acme"), undefined);
});

test("refuseSetPrincipalIfConflict blocks a second principal against established history", () => {
  const actor = { type: "agent", id: "codex" };
  const retiredAlice = cred({ actor, principal: alice, retired_at: "2026-09-01T00:00:00Z" });
  assert.match(refuseSetPrincipalIfConflict([retiredAlice], "acme", actor, bob)!, /already bound to human\/alice@acme\.dev/);
  assert.equal(refuseSetPrincipalIfConflict([retiredAlice], "acme", actor, alice), undefined);
  const both = [retiredAlice, cred({ actor, principal: bob, retired_at: "2026-09-02T00:00:00Z" })];
  assert.match(refuseSetPrincipalIfConflict(both, "acme", actor, bob)!, /history already conflicts/);
});
