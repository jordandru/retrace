import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundPrincipals,
  formatPrincipal,
  parseActorRef,
  parsePrincipalRef,
  projectIssuanceStatus,
  refuseReissueIfBound,
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

test("T29: refuseReissueIfBound names the original principal; same principal is allowed; missing is not guessed", () => {
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
  assert.equal(refuseReissueIfBound([missing], "acme", actor, bob), undefined, "missing principal is not guessed");

  const conflict = [
    cred({ actor, principal: alice, retired_at: "2026-09-01T00:00:00Z" }),
    cred({ actor, principal: bob, retired_at: "2026-09-02T00:00:00Z" }),
  ];
  assert.match(refuseReissueIfBound(conflict, "acme", actor, alice)!, /human\/alice@acme\.dev, human\/bob@acme\.dev/);
});
