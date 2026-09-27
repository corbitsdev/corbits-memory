// A local HTTP server standing in for an embed or rerank endpoint. Each test
// sets `reply`; every request is recorded with its path, auth header and
// JSON body (both clients only send JSON).

export type StubRequest = {
  path: string;
  authorization: string | null;
  body: unknown;
};

export type HttpStub = {
  url: string;
  requests: StubRequest[];
  reply: (req: StubRequest) => Response | Promise<Response>;
  reset: () => void;
  stop: () => void;
};

const unconfigured = () => new Response("no reply configured", { status: 500 });

export function startHttpStub(): HttpStub {
  const stub: HttpStub = {
    url: "",
    requests: [],
    reply: unconfigured,
    reset: () => {
      stub.requests.length = 0;
      stub.reply = unconfigured;
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const recorded: StubRequest = {
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: await req.json(),
      };
      stub.requests.push(recorded);
      return stub.reply(recorded);
    },
  });
  stub.url = server.url.href.replace(/\/$/, "");
  return stub;
}
