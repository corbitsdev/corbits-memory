import { describe, expect, it } from "bun:test";

import {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_WORKFLOW_ID,
} from "./constants.js";
import { SIDECAR_BUNDLE_ID } from "../sidecar-bundle.js";
import { createResidentDistiller } from "./workflow.js";

describe("createResidentDistiller", () => {
  it("returns a mail-triggered workflow with memory tools on the agent", () => {
    const { workflow, agent, generatorAgentId } = createResidentDistiller({
      mailTo: "resident-distiller@tenant.example.com",
      inference: {
        sources: [{ provider: "openai", model: "gpt-4.1-mini" }],
      },
    });

    expect(generatorAgentId).toBe(RESIDENT_DISTILLER_AGENT_ID);
    expect(workflow.id).toBe(RESIDENT_DISTILLER_WORKFLOW_ID);
    expect(workflow.triggers).toEqual([
      { type: "mail", to: "resident-distiller@tenant.example.com" },
    ]);
    expect(agent.id).toBe(RESIDENT_DISTILLER_AGENT_ID);
    // One factory: the memory sidecar bundle carries every memory tool.
    expect(agent.toolFactories.map((factory) => factory.id)).toEqual([
      SIDECAR_BUNDLE_ID,
    ]);
    expect(agent.systemPrompt).toContain("memory_feed");
    expect(agent.systemPrompt).toContain(RESIDENT_DISTILLER_AGENT_ID);
  });

  it("allows mailTo and id overrides", () => {
    const { workflow, generatorAgentId, agent } = createResidentDistiller({
      id: "my-distiller",
      agentId: "my-agent",
      mailTo: "my-agent@acme.example.com",
      inference: {
        sources: [{ provider: "openai", model: "gpt-4.1-mini" }],
      },
    });
    expect(workflow.id).toBe("my-distiller");
    expect(generatorAgentId).toBe("my-agent");
    expect(workflow.triggers[0]).toEqual({
      type: "mail",
      to: "my-agent@acme.example.com",
    });
    expect(agent.systemPrompt).toContain("my-agent");
    expect(agent.systemPrompt).not.toContain(RESIDENT_DISTILLER_AGENT_ID);
  });

  it("does not carry a cron/schedule field in its public options", () => {
    const opts: import("./workflow.js").CreateResidentDistillerOpts = {
      mailTo: "resident-distiller@tenant.example.com",
      inference: { sources: [{ provider: "openai", model: "gpt-4.1-mini" }] },
    };
    expect("cron" in opts).toBe(false);
  });
});
