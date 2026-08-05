import type {
  CreateLinearSourceProviderOpts,
  LiveSearchItem,
  SourceProvider,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.linear.app/graphql";
const ADAPTER_ID = "linear";

const SEARCH_ISSUES_QUERY = `
query SearchIssues($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes {
      id
      identifier
      title
      description
      url
      updatedAt
      team {
        id
      }
    }
  }
}
`;

type LinearSearchNode = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  team?: { id?: string } | null;
};

type LinearSearchResponse = {
  data?: {
    searchIssues?: {
      nodes?: LinearSearchNode[];
    };
  };
  errors?: Array<{ message: string }>;
};

function snippetFrom(node: LinearSearchNode): string {
  const desc = node.description?.trim();
  if (desc && desc.length > 0) {
    return desc.length > 240 ? `${desc.slice(0, 237)}...` : desc;
  }
  return node.title?.trim() || node.identifier || node.id;
}

function scoreForRank(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / total;
}

/**
 * Thin Linear SourceProvider. Host supplies accessToken; OAuth and token
 * refresh live outside this package.
 */
export function createLinearSourceProvider(
  opts: CreateLinearSourceProviderOpts,
): SourceProvider {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const teamId = opts.teamId;

  return {
    id: ADAPTER_ID,
    async searchLive(params): Promise<LiveSearchItem[]> {
      const limit = params.limit ?? 8;
      const res = await fetchFn(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.accessToken}`,
        },
        body: JSON.stringify({
          query: SEARCH_ISSUES_QUERY,
          variables: { term: params.query, first: limit },
        }),
      });

      if (!res.ok) {
        throw new Error(
          `Linear GraphQL HTTP ${res.status}: ${await res.text()}`,
        );
      }

      const body = (await res.json()) as LinearSearchResponse;
      if (body.errors?.length) {
        throw new Error(
          `Linear GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      }

      let nodes = body.data?.searchIssues?.nodes ?? [];
      if (teamId) {
        nodes = nodes.filter((n) => n.team?.id === teamId);
      }
      nodes = nodes.slice(0, limit);

      return nodes.map((node, i) => {
        const externalRef = node.identifier?.trim() || node.id;
        const title = node.title?.trim() || externalRef;
        const item: LiveSearchItem = {
          adapter: ADAPTER_ID,
          externalRef,
          title,
          snippet: snippetFrom(node),
          score: scoreForRank(i, nodes.length),
          kind: "issue",
          citation: {
            adapter: ADAPTER_ID,
            external_ref: externalRef,
            open: {
              type: "issue",
              id: externalRef,
              ...(node.url ? { url: node.url } : {}),
            },
          },
        };
        if (node.updatedAt) {
          item.updatedAt = node.updatedAt;
        }
        return item;
      });
    },
  };
}
