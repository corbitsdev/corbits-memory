import { describe, expect, it, mock } from "bun:test";
import { createLinearSourceProvider } from "./provider.ts";

type FetchFn = NonNullable<
  Parameters<typeof createLinearSourceProvider>[0]["fetch"]
>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function asFetch(fn: (...args: Parameters<FetchFn>) => Promise<Response>): FetchFn {
  return fn as FetchFn;
}

describe("createLinearSourceProvider", () => {
  it("id is linear", () => {
    const provider = createLinearSourceProvider({
      accessToken: "test-token",
      fetch: asFetch(() => Promise.resolve(jsonResponse({ data: {} }))),
    });
    expect(provider.id).toBe("linear");
  });

  it("searchLive maps GraphQL nodes to LiveSearchItem (mocked, no network)", async () => {
    const fetchMock = mock(
      asFetch((url, init) => {
        expect(String(url)).toBe("https://api.linear.app/graphql");
        expect(init?.method).toBe("POST");
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer test-token");
        const body = JSON.parse(String(init?.body));
        expect(body.variables.term).toBe("ports");
        expect(body.variables.first).toBe(5);

        return Promise.resolve(
          jsonResponse({
            data: {
              searchIssues: {
                nodes: [
                  {
                    id: "uuid-1",
                    identifier: "CL-1",
                    title: "ports foundation",
                    description: "DocumentStore + SourceProvider",
                    url: "https://linear.app/x/issue/CL-1",
                    updatedAt: "2026-03-01T00:00:00.000Z",
                    team: { id: "team-a" },
                  },
                  {
                    id: "uuid-2",
                    identifier: "CL-2",
                    title: "unrelated",
                    description: "something else",
                    url: "https://linear.app/x/issue/CL-2",
                    team: { id: "team-a" },
                  },
                ],
              },
            },
          }),
        );
      }),
    );

    const provider = createLinearSourceProvider({
      accessToken: "test-token",
      fetch: fetchMock as FetchFn,
    });

    const hits = await provider.searchLive!({
      query: "ports",
      tenantId: "t1",
      principalId: "p1",
      limit: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      adapter: "linear",
      externalRef: "CL-1",
      title: "ports foundation",
      kind: "issue",
      snippet: "DocumentStore + SourceProvider",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(hits[0]?.citation).toEqual({
      adapter: "linear",
      external_ref: "CL-1",
      open: {
        type: "issue",
        id: "CL-1",
        url: "https://linear.app/x/issue/CL-1",
      },
    });
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("searchLive filters by teamId when set", async () => {
    const fetchMock = mock(
      asFetch(() =>
        Promise.resolve(
          jsonResponse({
            data: {
              searchIssues: {
                nodes: [
                  {
                    id: "a",
                    identifier: "CL-1",
                    title: "in team",
                    team: { id: "team-keep" },
                  },
                  {
                    id: "b",
                    identifier: "CL-2",
                    title: "other team",
                    team: { id: "team-drop" },
                  },
                ],
              },
            },
          }),
        ),
      ),
    );

    const provider = createLinearSourceProvider({
      accessToken: "tok",
      teamId: "team-keep",
      fetch: fetchMock as FetchFn,
    });

    const hits = await provider.searchLive!({
      query: "team",
      tenantId: "t",
      principalId: "p",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.externalRef).toBe("CL-1");
  });

  it("searchLive uses custom baseUrl", async () => {
    const fetchMock = mock(
      asFetch((url) => {
        expect(String(url)).toBe("https://example.test/graphql");
        return Promise.resolve(
          jsonResponse({ data: { searchIssues: { nodes: [] } } }),
        );
      }),
    );

    const provider = createLinearSourceProvider({
      accessToken: "tok",
      baseUrl: "https://example.test/graphql",
      fetch: fetchMock as FetchFn,
    });

    const hits = await provider.searchLive!({
      query: "x",
      tenantId: "t",
      principalId: "p",
    });
    expect(hits).toEqual([]);
  });

  it("searchLive throws on HTTP error (no silent empty)", async () => {
    const provider = createLinearSourceProvider({
      accessToken: "tok",
      fetch: asFetch(() =>
        Promise.resolve(new Response("nope", { status: 401 })),
      ),
    });

    await expect(
      provider.searchLive!({
        query: "x",
        tenantId: "t",
        principalId: "p",
      }),
    ).rejects.toThrow(/401/);
  });

  it("searchLive throws on GraphQL errors", async () => {
    const provider = createLinearSourceProvider({
      accessToken: "tok",
      fetch: asFetch(() =>
        Promise.resolve(
          jsonResponse({
            errors: [{ message: "rate limited" }],
          }),
        ),
      ),
    });

    await expect(
      provider.searchLive!({
        query: "x",
        tenantId: "t",
        principalId: "p",
      }),
    ).rejects.toThrow(/rate limited/);
  });
});
