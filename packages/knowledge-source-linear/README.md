# @corbits/knowledge-source-linear

Thin `SourceProvider` mapper for Linear. **Host owns OAuth, webhook signature
verification, and cron/reconciliation** — this package authenticates nothing.

## What this is

- `createLinearSourceProvider` — optional live search (`searchLive`) against the
  Linear GraphQL API using a host-supplied access token.
- Webhook mappers (`mapIssueCreated` / `mapIssueUpdated` / `mapIssueRemoved`, or
  `mapLinearWebhook`) — turn Linear issue webhook payloads into `AdaptedDocument`
  shapes ready for `knowledge.capture()`.

## What the host does

1. **OAuth / tokens** — obtain and refresh Linear access tokens; pass
   `accessToken` into the provider factory.
2. **Webhook verify** — validate Linear webhook signatures before calling a
   mapper; never trust raw body bytes without verification.
3. **Cron / backfill** — schedule reconciliation pulls if needed; call capture
   with mapped documents on a schedule.
4. **Capture** — call `knowledge.capture({ adapter: "linear", document })` (or
   the HTTP capture route) with the mapped document.

## Visibility rules (overshare guard)

| Linear issue | Mapped visibility |
| --- | --- |
| Private (`private: true` or `team.private: true`) | `private` (single principal) or `principals` (creator + assignee + subscribers only). **Never `tenant`.** |
| Team-visible | `tenant` (company-brain default). Never `source_acl`. |

Actor kind on all sync writes is always `adapter` — never the webhook installer's
human identity.

## Usage

```ts
import {
  createLinearSourceProvider,
  mapLinearWebhook,
} from "@corbits/knowledge-source-linear";

// Live search (host injects token; inject fetch in tests)
const linear = createLinearSourceProvider({
  accessToken: process.env.LINEAR_TOKEN!,
  teamId: "optional-team-filter",
});
// plane options.sources = [linear]

// Webhook path (host already verified the signature)
const mapped = mapLinearWebhook(payload);
if (mapped) {
  await knowledge.capture({
    adapter: "linear",
    document: mapped.document,
  });
}
```

## Tests

```bash
bun test
```

All network is mocked; fixtures under `fixtures/` drive golden AdaptedDocument
assertions.
