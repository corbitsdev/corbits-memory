# Document access = Interchange authz (not a second ACL)

**Status:** shipped hard cutover (grant tags + creator; baseline migrations)  
**Problem (historical):** the green plane shipped a **mini-ACL** (`visibility` mode + principal list + block list) that was parallel to Interchange grants. That path is removed.


## Source of truth

| Layer | Owner | Mechanism |
| --- | --- | --- |
| Who is the caller? | Host (Interchange) | `principal` + `tenant` on context / plane args |
| May they use knowledge at all? | Host grant store | `authorize(…, resource: "knowledge", action: "add" \| "find")` |
| Which **documents** may they see? | Host grant store + tags on the document | `authorize(…, resource: <tag>, action: "find")` for any tag on the doc |

There is **one** authorization system: `@intx/authz` + host `GrantStore`. The knowledge engine does not invent modes, allowlists, or block lists as a security boundary.

## Document model

Each document stores:

```ts
accessTags: string[]  // resource strings in grant-pattern space
createdByPrincipalId: string  // audit + default owner tag
```

### Default tags on `add`

When the caller does not pass tags/share:

1. Always tag: `knowledge.owner:<principalId>`
2. No other tags → **owner-only** (only principals granted `find` on that owner resource can see it; typically the owner has that grant, or the plane treats owner as implicit allow for the creating principal)

**Implicit owner rule (engine convenience, not a second ACL):** the creating principal may always find/recent their own documents without a matching grant tag. Everyone else must match a tag via `authorize`. This is equivalent to auto-issuing a creator grant without writing one.

### Explicit tags

```ts
plane.add({
  tenantId, principalId, title, text,
  accessTags: ["knowledge.space:eng", "knowledge.project:ke"],
})
```

Host issues grants such as:

```ts
{
  principalId: "alice",
  resource: "knowledge.space:eng",
  action: "find",
  effect: "allow",
  // …origin, etc.
}
```

Alice then sees any document tagged `knowledge.space:eng` (capability `knowledge`/`find` still required).

Patterns work: a grant on `knowledge.space:*` matches `knowledge.space:eng` via `@intx/authz` `matchPattern`.

### Share sugars (map to tags only)

Share helpers **must not** reintroduce visibility modes. They only mint tags:

| Sugar | Tags written |
| --- | --- |
| (default / private) | `knowledge.owner:<caller>` |
| `share: { tenant: true }` | `knowledge.owner:<caller>`, `knowledge.tenant:<tenantId>` |
| `share: { principals: ["p2","p3"] }` | `knowledge.owner:<caller>`, `knowledge.owner:p2`, `knowledge.owner:p3` |
| `share: { tags: ["knowledge.space:eng"] }` | `knowledge.owner:<caller>`, plus those tags |

**Removed:** `visibility: { mode: private|principals|tenant }`, `blockPrincipalIds`, product `acl.mode` / `acl.allow` / `acl.block` as security.

Deny is expressed as **absence of allow** (or an explicit deny grant in the host store with higher specificity) — not a document-row block list.

## Evaluation algorithm

### Capability (unchanged)

```ts
authorize(grantStore, principalId, tenantId, "knowledge", "find"|"add")
// effect must be "allow"
```

### Document access (new)

```ts
function canSeeDocument(doc, principalId, grantStore, tenantId):
  if doc.createdByPrincipalId === principalId:
    return true  // creator
  for tag of doc.accessTags:
    r = authorize(grantStore, principalId, tenantId, tag, "find")
    if r.effect === "allow":
      return true
  return false
```

**SQL / store path:** prefer expand-then-filter:

1. `collectGrants(principalId, tenantId)` once per request.
2. Keep allow-grants whose `action` matches `find` (exact or pattern).
3. Document is visible if creator **or** any `accessTags[i]` is matched by any allow grant resource pattern (`matchPattern(grant.resource, tag)`), and not denied by a more specific deny.

This keeps evaluation inside Interchange authz semantics (specificity, conditions, deny).

Injected `DocumentStore` backends still own enforcement for their mount; the **contract** is grant-tags + creator, not visibility modes. Some third-party stores are principal-bucket only and must document that they do not evaluate host grants.

## Live sources

Unchanged intentional tradeoff: live `SourceProvider` hits are **enrichment under host tokens**, not grant-tagged documents. Hosts that need local-only retrieval pass `sources: ["local"]`. Do not invent a second live ACL.

## Wire (HTTP)

`POST …/add` body (thin):

```json
{
  "title": "…",
  "text": "…",
  "access_tags": ["knowledge.space:eng"],
  "share": { "tenant": true, "principals": ["alice"], "tags": ["knowledge.space:eng"] }
}
```

Identity never in body. `access_tags` and `share` are optional; default owner-only.

`find` / `ask` / `recent` need no ACL body — principal from context + grant store.

## Schema

Document access is stored as:

| Column | Role |
| --- | --- |
| `access_tags text[]` | Resource strings in grant-pattern space (+ creator always allowed) |

There is no `visibility_mode`, principal-id array, block list, or dual-write ACL
column. Share sugar only mints tags via `resolveAccessTags`.

Fresh databases apply the baseline migrations (`0001_extensions.sql` +
`0002_knowledge_baseline.sql`) with `access_tags` from day one.

## Non-goals

- Group membership resolution inside the knowledge engine (host/roles issue grants).
- Per-chunk ACL.
- Live channel grant tags (host policy).
- Re-implementing roles inside this package.

## Acceptance

1. No public plane/HTTP API accepts `visibility` mode or block list as security.
2. Default add is owner-visible only (creator + owner tag).
3. Principal B sees A’s doc only when host grant allows `find` on a tag present on the doc (or B is creator).
4. Capability `knowledge`/`find` still required for find/ask/recent.
5. PRODUCT.md / MIGRATION.md / README describe grant tags, not mini-ACL.
6. Engine + fakes enforce the algorithm; vendor adapters document principal-bucket limit.
7. `bun run typecheck && bun run test` green.
