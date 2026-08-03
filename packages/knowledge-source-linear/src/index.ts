/**
 * @corbits/knowledge-source-linear
 *
 * Thin Linear SourceProvider + webhook → AdaptedDocument mappers.
 * Host owns OAuth, webhook signature verification, and cron.
 */

export { createLinearSourceProvider } from "./provider.ts";
export {
  mapIssueCreated,
  mapIssueUpdated,
  mapIssueRemoved,
  mapLinearWebhook,
  mapIssueToAdaptedDocument,
  ADAPTER,
} from "./map-webhook.ts";
export {
  mapIssueVisibility,
  collectPrincipalIds,
  isPrivateIssue,
} from "./visibility.ts";
export { contentHash, stableStringify } from "./hash.ts";

export type {
  LiveSearchItem,
  SourceProvider,
  AdaptedDocument,
  VisibilitySpec,
  LinearIssueData,
  LinearWebhookEvent,
  LinearWebhookAction,
  MappedWebhookResult,
  CreateLinearSourceProviderOpts,
  FetchLike,
} from "./types.ts";
