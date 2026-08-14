# Document access = Interchange authz (not a second ACL)

**Status:** grant tags + creator (baseline migrations)  
**Problem (historical):** an earlier mini-ACL (`visibility` mode + principal list + block list) ran parallel to Interchange grants. That path is gone — document access is grant tags only.



## Source of truth

| Layer | Owner | Mechanism |
| --- | --- | --- |
| Who is the caller? | Host (Interchange) | `principal` + `tenant` on context / plane args |
| May they use memory at all? | Host grant store | `authorize(…, resource: "memory", action: "add" \| "search")` |
| Which **documents** may they see? | Host grant store + tags on the document | `authorize(…, resource: <tag>, action: "search")` for any tag on the doc |

There is **one** authorization system: `@intx/authz` + host `GrantStore`. Corbits Memory does not invent modes, allowlists, or block lists as a security boundary.

## Document model

Each document stores:

```ts
accessTags: string[]  // resource strings in grant-pattern space
createdByPrincipalId: string  // audit + default owner tag
```

### Default tags on `add`

When the caller does not pass tags/share:

1. Always tag: `memory.owner:<principalId>`
2. No other tags → **owner-only by default**. The **creating** principal always
   sees their own docs (engine convenience). **Peers** need an explicit host
   grant of `search` on that owner resource (or a matching pattern) — the engine
   never auto-grants tags to anyone.


### Explicit tags

```ts
plane.add({
  tenantId, principalId, title, text,
  accessTags: ["memory.space:eng", "memory.project:ke"],
})
```

Host issues grants such as:

```ts
{
  principalId: "alice",
  resource: "memory.space:eng",
  action: "search",
  effect: "allow",
  // …origin, etc.
}
```

Alice then sees any document tagged `memory.space:eng` (capability `memory`/`search` still required).

Patterns work: a grant on `memory.space:*` matches `memory.space:eng` via `@intx/authz` `matchPattern`.

### Share sugars (map to tags only)

Share helpers **must not** reintroduce visibility modes. They only mint tags:

| Sugar | Tags written |
| --- | --- |
| (omit `share` — owner-only default) | `memory.owner:<caller>` |
| `share: { tenant: true }` | `memory.owner:<caller>`, `memory.tenant:<tenantId>` |
| `share: { principals: ["p2","p3"] }` | `memory.owner:<caller>`, `memory.owner:p2`, `memory.owner:p3` |
| `share: { tags: ["memory.space:eng"] }` | `memory.owner:<caller>`, plus those tags |

There is **no** `share.private` key. Owner-only is the default when `share` is omitted.

### Host contract for multi-user share (required)

Tag minting is **not** grant minting. For peer share to work in product:

1. When Alice adds with `share: { principals: ["bob"] }`, the document is tagged
   `memory.owner:alice` and (after insert) `memory.doc:<documentId>`.
2. When the host grant store implements `WritableGrantStore.putGrant`, memory
   **materializes** an allow/`search` grant for Bob on `memory.doc:<documentId>`
   (origin `system`, conditions carry `memoryShare` / `sharedBy` / `sourceVersionId`
   for audit). Peers can then pass `canAccessDocument` without a separate
   bootstrap grant on `memory.owner:bob`.
3. Without a writable grant store, tags alone are written and peers still need
   host-side grants (fail-closed empty search). Log warns on this path.
4. `share.tenant` / `share.tags` still only mint tags — hosts issue role/pattern
   grants on those resources (no auto-principal grants).

### Audience widening (write-narrow-then-widen)

Distiller / claim writes that propose tags **beyond** the source document's
audience must not silently widen:

1. `splitAudienceWiden(sourceTags, proposed)` → write with `allowed` only.
2. After **source-owner** approval, append `needsApproval` tags and materialize
   any peer grants; store `shareWidenReceipt` on version attributes.

Ask-on-read (`authorize` effect `"ask"`) remains **fail-closed** in
`canAccessDocument` (design-only; no flag in v1).

**Removed:** `visibility: { mode: private|principals|tenant }`, `blockPrincipalIds`, product `acl.mode` / `acl.allow` / `acl.block` as security.

Deny is expressed as **absence of allow** (or an explicit deny grant in the host store with higher specificity) — not a document-row block list.

## Evaluation algorithm

### Capability (unchanged)

```ts
authorize(grantStore, principalId, tenantId, "memory", "search"|"add")
// effect must be "allow"
```

### Document access (new)

```ts
function canSeeDocument(doc, principalId, grantStore, tenantId):
  if doc.createdByPrincipalId === principalId:
    return true  // creator
  for tag of doc.accessTags:
    r = authorize(grantStore, principalId, tenantId, tag, "search")
    if r.effect === "allow":
      return true
  return false
```

**SQL / store path:** prefer expand-then-filter:

1. `collectGrants(principalId, tenantId)` once per request.
2. Keep allow-grants whose `action` matches `search` (exact or pattern).
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
  "access_tags": ["memory.space:eng"],
  "share": { "tenant": true, "principals": ["alice"], "tags": ["memory.space:eng"] }
}
```

Identity never in body. `access_tags` and `share` are optional; default owner-only.

`search` / `list` need no ACL body — principal from context + grant store.


## Schema

Document access is stored as:

| Column | Role |
| --- | --- |
| `access_tags text[]` | Resource strings in grant-pattern space (+ creator always allowed) |

There is no `visibility_mode`, principal-id array, block list, or dual-write ACL
column. Share sugar only mints tags via `resolveAccessTags`.

Fresh databases apply the baseline migrations (`0001_extensions.sql` +
`0002_memory_baseline.sql`) with `access_tags` from day one.

## Non-goals

- Group membership resolution inside Corbits Memory (host/roles issue grants).
- Per-chunk ACL.
- Live channel grant tags (host policy).
- Re-implementing roles inside this package.

## Acceptance

1. No public plane/HTTP API accepts `visibility` mode or block list as security.
2. Default add is owner-visible only (creator + owner tag).
3. Principal B sees A’s doc only when host grant allows `search` on a tag present on the doc (or B is creator).
4. Capability `memory`/`search` still required for search/list.
5. PRODUCT.md / README describe grant tags, not mini-ACL.

6. Engine + fakes enforce the algorithm; vendor adapters document principal-bucket limit.
7. `bun run typecheck && bun run test` green.
