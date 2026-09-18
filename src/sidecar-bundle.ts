// Sidecar-bundle entry for `@corbits/memory` — the convention-compliant
// factory the tool-package loader invokes, so a deployed agent carries the
// memory tools without any agent-owned client code.
//
// The bundle holds no database handle and no secret. It resolves the `hub`
// credential handle from the host-assembled runtime capabilities and calls
// the run-scoped memory routes through that mediated fetch, which is pinned
// to the hub's own origin and injects the agent's bearer per request. The
// env keys it touches (`capabilities`, `address`) are declared in `requires`:
// `address` is the run address the routes scope every call to.
import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { MEMORY_TOOL_DEFINITIONS } from "./tools.ts";

/** Where a host mounts `mountWorkflowMemory`. The bundle has no options of
 * its own — the loader constructs it — so the path is a shared constant
 * rather than per-deploy configuration. */
export const WORKFLOW_MEMORY_BASE_PATH = "/api/workflow-memory";

/** The credential handle this package declares, and the one a host binds the
 * agent's hub token to. */
export const HUB_CREDENTIAL_HANDLE = "hub";

export const SIDECAR_BUNDLE_ID = "@corbits/memory/sidecar-bundle";

type MediatedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type HttpCredential = {
  readonly kind: string;
  fetch: MediatedFetch;
  dispose(): void | Promise<void>;
};

/** The slice of the host-assembled runtime capabilities this bundle uses. */
type CredentialCapabilities = {
  resolve(key: "credentials"): { resolve(handle: string): Promise<HttpCredential> };
};

/** The env keys `requires` declares, on top of the core ones. */
export type MemoryToolEnv = BaseEnv & {
  readonly capabilities: CredentialCapabilities;
  readonly address: string;
};

type Request_ = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
};

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

function defined(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );
}

/** Maps one model-facing tool call onto the run-scoped route that performs
 * it. An unknown name returns undefined and answers as a tool error. */
function requestFor(name: string, args: Record<string, unknown>): Request_ | undefined {
  switch (name) {
    case "memory_add":
      return {
        method: "POST",
        path: "/add",
        body: defined({
          title: args["title"],
          text: args["text"],
          access_tags: args["access_tags"],
          kind: args["kind"],
          generator_agent_id: args["generator_agent_id"],
          provenance: args["provenance"],
          lineage_class: args["lineage_class"],
          temporal_class: args["temporal_class"],
          derived_from: args["derived_from"],
          valid_from: args["valid_from"],
          valid_until: args["valid_until"],
          share: args["share"],
        }),
      };
    case "memory_search":
      return {
        method: "POST",
        path: "/search",
        body: defined({
          query: args["query"],
          limit: args["limit"],
          kinds: args["kinds"],
          entity_ids: args["entity_ids"],
          sources: args["sources"],
          includeEvidence: args["includeEvidence"],
          includeDeprecated: args["includeDeprecated"],
        }),
      };
    case "memory_list":
      return { method: "GET", path: `/list${query({ limit: args["limit"] })}` };
    case "memory_feed":
      return {
        method: "GET",
        path: `/feed${query({
          after: args["after"],
          limit: args["limit"],
          exclude_generator: args["exclude_generator"],
        })}`,
      };
    default:
      return undefined;
  }
}

/** The loader may present a namespaced name; the switch above keys on the
 * declared one. */
function bareToolName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

async function readErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return `the hub answered ${String(response.status)}`;
}

/** The path is relative on purpose: a mediated http handle resolves it
 * against the origin it is pinned to, so the bundle never names a host. */
export async function callMemoryRoute(
  fetchImpl: MediatedFetch,
  runAddress: string,
  request: Request_,
): Promise<unknown> {
  const response = await fetchImpl(`${WORKFLOW_MEMORY_BASE_PATH}${request.path}`, {
    method: request.method,
    headers: {
      "x-workflow-run-address": runAddress,
      ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

// Bound to a const rather than passed as a fresh object literal: some
// `@intx/agent` versions add a static `definitions` field to defineTool's
// options, which an older pinned version predates — structural assignment
// type-checks against either shape.
const bundleOpts = {
  id: SIDECAR_BUNDLE_ID,
  requires: ["capabilities", "address"] as const,
  definitions: MEMORY_TOOL_DEFINITIONS.map((def) => ({ name: def.name })),
  factory: (env: MemoryToolEnv) => {
    let handle: Promise<HttpCredential> | undefined;

    function hub(): Promise<HttpCredential> {
      handle ??= (async () => {
        const credential = await env.capabilities
          .resolve("credentials")
          .resolve(HUB_CREDENTIAL_HANDLE);
        if (credential.kind !== "http") {
          throw new Error(
            `the "${HUB_CREDENTIAL_HANDLE}" credential is a ${credential.kind} handle; the memory tools need an http one`,
          );
        }
        return credential;
      })();
      return handle;
    }

    return {
      definitions: MEMORY_TOOL_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema as unknown as Record<string, unknown>,
      })),
      async run(call: ToolCall): Promise<ToolResult> {
        const name = bareToolName(call.name);
        const request = requestFor(name, call.arguments);
        if (request === undefined) {
          return { callId: call.id, content: `unknown memory tool: ${call.name}`, isError: true };
        }
        try {
          const credential = await hub();
          const data = await callMemoryRoute(
            (input, init) => credential.fetch(input, init),
            env.address,
            request,
          );
          return { callId: call.id, content: JSON.stringify(data) };
        } catch (error) {
          return {
            callId: call.id,
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
      async dispose() {
        if (handle === undefined) return;
        await (await handle).dispose();
      },
    };
  },
};

/**
 * The named export the loader picks up. `factory` is synchronous while the
 * credential resolve is not, so the handle is resolved lazily on first use
 * and the promise memoized — one resolve, one handle to dispose.
 */
export const memory = defineTool<MemoryToolEnv>(bundleOpts);
