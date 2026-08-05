import { contentHash } from "./hash.ts";
import type {
  AdaptedDocument,
  LinearIssueData,
  LinearWebhookAction,
  LinearWebhookEvent,
  MappedWebhookResult,
} from "./types.ts";
import { mapIssueVisibility } from "./visibility.ts";

const ADAPTER = "linear";
const KIND_ISSUE = "issue";

function externalRef(data: LinearIssueData): string {
  return data.identifier?.trim() || data.id;
}

function issueTitle(data: LinearIssueData): string {
  const t = data.title?.trim();
  return t && t.length > 0 ? t : externalRef(data);
}

function issueUrl(data: LinearIssueData, eventUrl?: string): string | undefined {
  return data.url ?? eventUrl ?? undefined;
}

function buildAttributes(
  data: LinearIssueData,
  opts: { removed?: boolean } = {},
): Record<string, string | number | boolean | null> {
  const attrs: Record<string, string | number | boolean | null> = {
    linear_id: data.id,
  };
  if (data.identifier != null) attrs.identifier = data.identifier;
  if (data.priority != null) attrs.priority = data.priority;
  if (data.teamId != null) attrs.team_id = data.teamId;
  if (data.stateId != null) attrs.state_id = data.stateId;
  if (data.state?.name != null) attrs.state_name = data.state.name;
  if (data.state?.type != null) attrs.state_type = data.state.type;
  if (data.assigneeId != null) attrs.assignee_id = data.assigneeId;
  if (data.creatorId != null) attrs.creator_id = data.creatorId;
  const url = issueUrl(data);
  if (url != null) attrs.url = url;
  if (opts.removed) attrs.removed = true;
  return attrs;
}

function buildChunks(data: LinearIssueData, removed: boolean): Array<{
  ordinal: number;
  text: string;
}> {
  if (removed) return [];
  const parts: string[] = [];
  const title = issueTitle(data);
  parts.push(title);
  const desc = data.description?.trim();
  if (desc) parts.push(desc);
  const text = parts.join("\n\n");
  if (!text) return [];
  return [{ ordinal: 0, text }];
}

function entityHints(data: LinearIssueData): unknown[] {
  const hints: unknown[] = [];
  const assigneeName = data.assignee?.name;
  const assigneeId = data.assigneeId ?? data.assignee?.id;
  if (assigneeId) {
    hints.push({
      kind: "person",
      identifier: assigneeId,
      ...(assigneeName ? { label: assigneeName } : {}),
    });
  }
  const creatorName = data.creator?.name;
  const creatorId = data.creatorId ?? data.creator?.id;
  if (creatorId && creatorId !== assigneeId) {
    hints.push({
      kind: "person",
      identifier: creatorId,
      ...(creatorName ? { label: creatorName } : {}),
    });
  }
  return hints;
}

/**
 * Core mapper: Linear issue data → AdaptedDocument.
 * Actor is always `adapter` for sync writes (never webhook installer identity).
 */
export function mapIssueToAdaptedDocument(
  data: LinearIssueData,
  opts: { removed?: boolean } = {},
): AdaptedDocument {
  const removed = opts.removed === true;
  const title = issueTitle(data);
  const ref = externalRef(data);
  const attributes = buildAttributes(data, { removed });
  const chunks = buildChunks(data, removed);
  const visibility = mapIssueVisibility(data);

  const doc: AdaptedDocument = {
    kind: KIND_ISSUE,
    title,
    externalRef: ref,
    visibility,
    entityHints: entityHints(data),
    chunks,
    // Sync writes always attribute to the adapter, never the installer.
    actor: { kind: "adapter" },
    contentHash: contentHash({
      title,
      kind: KIND_ISSUE,
      externalRef: ref,
      attributes,
      chunkTexts: chunks.map((c) => c.text),
    }),
    attributes,
  };
  return doc;
}

export function mapIssueCreated(event: LinearWebhookEvent): AdaptedDocument {
  return mapIssueToAdaptedDocument(event.data, { removed: false });
}

export function mapIssueUpdated(event: LinearWebhookEvent): AdaptedDocument {
  return mapIssueToAdaptedDocument(event.data, { removed: false });
}

export function mapIssueRemoved(event: LinearWebhookEvent): AdaptedDocument {
  return mapIssueToAdaptedDocument(event.data, { removed: true });
}

/**
 * Dispatch by webhook action. Returns null for non-Issue types or unknown actions.
 */
export function mapLinearWebhook(
  event: LinearWebhookEvent,
): MappedWebhookResult | null {
  const type = (event.type ?? "Issue").toLowerCase();
  if (type !== "issue") return null;

  const action = event.action as LinearWebhookAction | string;
  if (action === "create") {
    return { action: "create", document: mapIssueCreated(event) };
  }
  if (action === "update") {
    return { action: "update", document: mapIssueUpdated(event) };
  }
  if (action === "remove") {
    return { action: "remove", document: mapIssueRemoved(event) };
  }
  return null;
}

export { ADAPTER };
