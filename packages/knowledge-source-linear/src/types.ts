/**
 * Local port types matching @corbits/knowledge-engine SourceProvider /
 * AdaptedDocument contracts. Defined here so this package has no hard
 * dependency on the engine (plugin boundary).
 */

export type LiveSearchItem = {
  adapter: string;
  externalRef: string;
  title: string;
  snippet: string;
  score: number;
  kind: string;
  citation: {
    adapter: string;
    external_ref: string;
    open: { type: string; id: string; url?: string };
  };
  updatedAt?: string;
};

export type SourceProvider = {
  readonly id: string;
  searchLive?(params: {
    query: string;
    tenantId: string;
    principalId: string;
    limit?: number;
  }): Promise<LiveSearchItem[]>;
};

export type VisibilitySpec = {
  mode: "private" | "tenant" | "principals";
  principalIds?: string[];
};

/** Capture-ready document shape (AdaptedDocument-ish). */
export type AdaptedDocument = {
  kind: string;
  title: string;
  externalRef: string;
  visibility: VisibilitySpec;
  entityHints: unknown[];
  chunks: Array<{ ordinal: number; text: string }>;
  actor: { kind: "adapter" | "human"; principalId?: string };
  contentHash: string;
  attributes?: Record<string, string | number | boolean | null>;
};

/** Linear issue fields we read from webhooks / GraphQL (subset). */
export type LinearIssueData = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  teamId?: string | null;
  creatorId?: string | null;
  assigneeId?: string | null;
  subscriberIds?: string[] | null;
  stateId?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  /** Explicit private flag when present on the payload. */
  private?: boolean | null;
  team?: {
    id?: string;
    key?: string | null;
    name?: string | null;
    private?: boolean | null;
  } | null;
  creator?: { id?: string; name?: string | null } | null;
  assignee?: { id?: string; name?: string | null } | null;
  state?: { id?: string; name?: string | null; type?: string | null } | null;
};

export type LinearWebhookAction = "create" | "update" | "remove";

export type LinearWebhookEvent = {
  action: LinearWebhookAction | string;
  type?: string;
  data: LinearIssueData;
  url?: string;
  createdAt?: string;
  updatedFrom?: Record<string, unknown>;
};

export type MappedWebhookResult = {
  action: LinearWebhookAction;
  document: AdaptedDocument;
};

/** Minimal fetch shape so tests/mocks need not implement full Fetch API. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CreateLinearSourceProviderOpts = {
  accessToken: string;
  /** Optional team filter for live search. */
  teamId?: string;
  /** Injectable fetch (tests mock Linear GraphQL). */
  fetch?: FetchLike;
  /** Default https://api.linear.app/graphql */
  baseUrl?: string;
};
