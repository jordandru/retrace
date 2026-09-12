# Minimum API Token Policies: D1-Only Mint vs Secret-Write

**Status:** measurement, 2026-09-12. Author: grok (measurer). Instruction
`evt_e27fafb81df84756ad95dcec7d22eeae`. Class (b) under agent-rules 12 —
documents Cloudflare's published token permission model; does not govern
Retrace behaviour. Companion evidence for credential-store §2.1 (PR 42
Codex P1: D1-write and secret-write are distinct permissions). This is a
public-docs check, not an account-specific permission test and not a live
curl against this Cloudflare account.

**Date checked:** 2026-09-12
**Scope:** Three minimum API token policy JSON objects for Cloudflare's create-token API. Primary sources only.

**Measurer re-check (same date):** cited pages were re-fetched 2026-09-12.
The permissions catalog prints two account-permission tables on one page:
the first names the D1 write group `D1 Edit` and the Workers write group
`Workers Scripts Edit`; the second names them `D1 Write` and `Workers
Scripts Write`. API endpoint "Accepted Permissions" use the Write names
(`D1 Write`, `Workers Scripts Write`). Token JSON in this note uses the
Write names because those are what the create-token / endpoint docs
accept. Whether Edit and Write are two names for one UUID remains
**unproven** without `GET /user/tokens/permission_groups`. Secrets Store
does not appear in the token-permission catalog (confirmed by search of
the page). No 2026 D1 changelog entry consolidates D1 and Workers
permissions.

---

## Token A — D1-Only Writer (the threat we are accepting)

**Goal:** Can POST D1 SQL (INSERT/UPDATE/DELETE on `retrace-db`) via API, cannot add/update/delete Worker script secrets, cannot deploy Worker code, cannot edit Secrets Store.

```json
{
  "name": "retrace-d1-writer",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {
          "id": "<D1_WRITE_PERMISSION_GROUP_ID_FROM_GET_USER_TOKENS_PERMISSION_GROUPS>",
          "name": "D1 Write",
          "meta": {}
        }
      ],
      "resources": {
        "com.cloudflare.api.account.<ACCOUNT_ID>": "*"
      }
    }
  ]
}
```

### D1 Write permission group UUID

**Unproven from public docs.** The permissions reference lists "D1 Write" as a name with scope `com.cloudflare.api.account` but does not show its UUID ([permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). The `GET /user/tokens/permission_groups` endpoint returns UUIDs, but its public example response only shows a few entries (Billing Read, Load Balancing, Workers KV, Workers Scripts) — D1 is not in the truncated example ([permission_groups list](https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/permission_groups/methods/list/)).

**Curl to resolve the UUID (no token values):**

```bash
curl https://api.cloudflare.com/client/v4/user/tokens/permission_groups \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | \
  python3 -c "import sys,json; [print(f'{g[\"id\"]} {g[\"name\"]}') for g in json.load(sys.stdin)['result'] if 'D1' in g['name']]"
```

### Resources key

The `resources` format uses `com.cloudflare.api.account.<ACCOUNT_ID>` with `"*"` as the wildcard for account-scoped permissions ([Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)). Whether a token can be scoped to a single D1 database (rather than account-wide) is **unproven** — the docs show account-level and zone-level resource scoping, not database-level. The minimum documented scope is account-scoped D1 Write.

### Positive test

`POST /accounts/<ACCOUNT_ID>/d1/database/<DATABASE_ID>/query` with body `{"sql": "INSERT INTO credentials (token_hash) VALUES (?)"}` — succeeds with D1 Write ([D1 query endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/); [Node.js ref showing accepted permissions](https://developers.cloudflare.com/api/node/resources/d1/subresources/database/methods/query/)).

### Negative tests

- `PUT /accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>/secrets` — returns 403. Token A does not carry Workers Scripts Write ([Workers scripts secrets endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)).
- `PUT /accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>` (script upload/deploy) — returns 403. Same permission gap ([Workers scripts upload endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)).
- Secrets Store: no Secrets Store permission group appears in the API token permissions catalog ([permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). Endpoint/403 behavior is **unproven** — Secrets Store is managed via account roles, not token permissions ([account roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)).

### Dashboard D1 editor

**Unproven.** The account roles page does not list any role that explicitly mentions D1 ([account roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)). No public role-to-permission matrix maps dashboard roles to individual permission names. Whether a dashboard member can have D1 edit access without Workers Scripts write is **unproven** from public docs.

---

## Token B — Minimum Token That Can Write Classic Worker Secrets

**Goal:** Can `wrangler secret put` / `PUT /accounts/{id}/workers/scripts/{name}/secrets`, cannot D1 query/write.

**"Secrets-only" is not constructible** at the API token permission level. Workers Scripts Write covers both secrets and script upload/deploy — the same permission is accepted on both the secrets endpoint and the script-upload endpoint ([Node.js ref for secrets](https://developers.cloudflare.com/api/node/resources/workers/subresources/scripts/subresources/secrets/methods/update/); [Node.js ref for script upload](https://developers.cloudflare.com/api/node/resources/workers/subresources/scripts/methods/update/)). The Workers secrets docs confirm: "`wrangler secret put` creates a new version of the Worker and deploys it immediately" ([Workers secrets docs](https://developers.cloudflare.com/workers/configuration/secrets/)). The minimum grant that enables `wrangler secret put` also enables `wrangler deploy`. This is larger than minting.

```json
{
  "name": "retrace-secrets-writer",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {
          "id": "e086da7e2179491d91ee5f35b3ca210a",
          "name": "Workers Scripts Write",
          "meta": {}
        }
      ],
      "resources": {
        "com.cloudflare.api.account.<ACCOUNT_ID>": "*"
      }
    }
  ]
}
```

### Workers Scripts Write permission group UUID

**`e086da7e2179491d91ee5f35b3ca210a`** — appears in the public example response of `GET /user/tokens/permission_groups` ([permission_groups list](https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/permission_groups/methods/list/)). Whether this UUID is stable across all accounts or is account-specific is **unproven**. Verify with the curl above.

### Resources key

Account-scoped, same as Token A. Whether a token can be scoped to a single Worker script (rather than account-wide) is **unproven** — the docs show account-level and zone-level resource scoping, not script-level. The minimum documented scope is account-scoped Workers Scripts Write.

### Positive tests

- `PUT /accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>/secrets` — succeeds with Workers Scripts Write ([secrets endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)).
- `PUT /accounts/<ACCOUNT_ID>/workers/scripts/<SCRIPT_NAME>` (upload/deploy) — also succeeds, same permission ([script upload endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)).

### Negative test

`POST /accounts/<ACCOUNT_ID>/d1/database/<DATABASE_ID>/query` with `INSERT` SQL — returns 403. Token B does not carry D1 Write ([D1 query endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)).

### What Token B can also do (beyond secrets)

Workers Scripts Write covers ([Node.js ref](https://developers.cloudflare.com/api/node/resources/workers/subresources/scripts/subresources/secrets/methods/update/)): add/remove/list secrets, upload Worker module, upload Worker Version, configure deployments, delete Worker, fetch raw script content, list uploaded Workers. A principal with Token B can replace the Worker's code entirely — not just manage secrets.

---

## Token C — Super Administrator (Not Minimum)

"Super Administrator" is an **account member role**, not an API token permission group ([account roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)). It "can edit any Cloudflare setting, make purchases, update billing, manage members, and create account-owned API tokens."

For this threat surface (D1 + Workers Scripts + Secrets Store), an API-token equivalent would combine Token A + Token B:

```json
{
  "name": "retrace-admin-equivalent",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {
          "id": "<D1_WRITE_PERMISSION_GROUP_ID_FROM_GET_USER_TOKENS_PERMISSION_GROUPS>",
          "name": "D1 Write",
          "meta": {}
        },
        {
          "id": "e086da7e2179491d91ee5f35b3ca210a",
          "name": "Workers Scripts Write",
          "meta": {}
        }
      ],
      "resources": {
        "com.cloudflare.api.account.<ACCOUNT_ID>": "*"
      }
    }
  ]
}
```

### What Token C implies

- **Implies Token A** (D1 Write): can query/write D1 via REST API.
- **Implies Token B** (Workers Scripts Write): can manage Worker secrets and deploy Worker code.
- **Secrets Store**: no Secrets Store permission group appears in the API token permissions catalog ([permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). Secrets Store is managed via account roles: Secrets Store Admin, Deployer, Reporter ([account roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)). Whether Super Administrator's "edit any Cloudflare setting" includes Secrets Store is **implied but unproven** from the role description alone.

---

## Permission Summary Table

| Permission name | UUID | Token A | Token B | Token C | Cited URL |
|---|---|---|---|---|---|
| D1 Write | Unproven (not in public docs) | **Yes** | — | Yes | [permissions ref](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Workers Scripts Write | `e086da7e2179491d91ee5f35b3ca210a` | — | **Yes** | Yes | [permission_groups list](https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/permission_groups/methods/list/) |
| Secrets Store (token permission) | Not found in catalog | — | — | Via role, not token | [permissions ref](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |

**UUID caveats:** The Workers Scripts Write UUID appears in the public example response of `GET /user/tokens/permission_groups`. The D1 Write UUID does not appear in any public doc or example. Whether these UUIDs are stable across all accounts or are account-specific is **unproven** — the docs do not state this.

---

## Wrangler Permission Mapping

| Wrangler command | Underlying API endpoint | Accepted permission (raw API) | Same permission in Wrangler? | Source |
|---|---|---|---|---|
| `wrangler secret put` | `PUT /accounts/{id}/workers/scripts/{name}/secrets` | Workers Scripts Write | Corresponding raw endpoint requires Workers Scripts Write; exact Wrangler call path **unproven** | [Workers secrets docs](https://developers.cloudflare.com/workers/configuration/secrets/); [Node.js API ref](https://developers.cloudflare.com/api/node/resources/workers/subresources/scripts/subresources/secrets/methods/update/) |
| `wrangler d1 execute` | `POST /accounts/{id}/d1/database/{uuid}/query` | D1 Read / D1 Write | Likely corresponds to D1 REST query, but Wrangler-specific permission doc not found; raw API requires D1 Read/Write | [D1 query endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) |
| `wrangler deploy` | `PUT /accounts/{id}/workers/scripts/{name}` | Workers Scripts Write | Corresponding raw endpoint requires Workers Scripts Write; exact Wrangler call path **unproven** | [Workers scripts upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) |

---

## Account Roles vs Token Permissions

### Can you attach both A and B to one user via different tokens?

**Yes.** A single Cloudflare account member can have multiple API tokens, each with different permission groups ([create token API](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/create/)). One token can carry D1 Write (Token A) and another can carry Workers Scripts Write (Token B). The user's account role is separate from their API token permissions.

### Can a dashboard user have D1 Edit without Workers Scripts Write?

**Unproven.** The account roles page ([source](https://developers.cloudflare.com/fundamentals/manage-members/roles/)) does not list any role that explicitly mentions D1. No public role-to-permission matrix maps account roles to individual permission names.

### Which default roles include D1 Write but not Workers Scripts Write, and vice versa?

**Unproven.** No account-scoped role explicitly mentions D1 or Workers Scripts in its description ([account roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)). The closest roles:

| Role | Description | D1 Write? | Workers Scripts Write? |
|---|---|---|---|
| Super Administrator - All Privileges | Can edit any Cloudflare setting | Yes (implied) | Yes (implied) |
| Administrator | Can access full account and edit subscriptions | Unproven | Unproven |
| Workers Platform Admin | Edit/read to all Developer Platform products | Unproven (likely) | Unproven (likely) |
| Workers Editor | Can use the Workers Playground | Unproven | Unproven |
| Secrets Store Admin | Create/edit/delete secrets metadata + add binding | No (not mentioned) | No (not mentioned) |

No role matrix is public. All "implied" and "likely" entries are **unproven** from the docs.

---

## Verdict

Therefore a D1-only mint is **possible in Cloudflare's documented permission model** — D1 Write and Workers Scripts Write are separately named, independently grantable permission groups, and the D1 query endpoint accepts INSERT/UPDATE/DELETE SQL via REST API ([D1 query endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/); [permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). The reviewer's claim is correct: a principal with D1 Write but not Workers Scripts Write can INSERT a hash of a token they know into the registry, and the Worker will treat it as a live credential on the next request (if the registry has no row-level MAC/signature). However, the exact Token A create-token JSON is **not fully constructible from public docs** — the D1 Write permission-group UUID is not published in any Cloudflare doc or example response. You must call `GET /user/tokens/permission_groups` with a valid API token to resolve it.

---

## 2026 Changelog

**No 2026 changelog entry merged D1 and Workers permissions.** No entry in the D1 changelog ([source](https://developers.cloudflare.com/changelog/product/d1/)) or the permissions reference page describes a consolidation of D1 and Workers Scripts permission groups. The permissions remain separate entries in the token permission catalog (last updated 2026-08-25).
