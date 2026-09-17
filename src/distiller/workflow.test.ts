import { describe, expect, it } from "bun:test";

import {
  RESIDENT_DISTILLER_AGENT_ID,
  RESIDENT_DISTILLER_WORKFLOW_ID,
} from "./constants.ts";
import { createResidentDistiller } from "./workflow.ts";

describe("createResidentDistiller", () => {
  it("returns a schedule workflow with memory tools on the agent", () => {
    const { workflow, agent, generatorAgentId } = createResidentDistiller({
      inference: {
        sources: [{ provider: "openai", model: "gpt-4.1-mini" }],
      },
    });

    expect(generatorAgentId).toBe(RESIDENT_DISTILLER_AGENT_ID);
    expect(workflow.id).toBe(RESIDENT_DISTILLER_WORKFLOW_ID);
    expect(workflow.triggers).toEqual([
      { type: "schedule", cron: "*/5 * * * *" },
    ]);
    expect(agent.id).toBe(RESIDENT_DISTILLER_AGENT_ID);
    expect(agent.toolFactories.length).toBeGreaterThanOrEqual(3);
    expect(agent.systemPrompt).toContain("memory_feed");
    expect(agent.systemPrompt).toContain(RESIDENT_DISTILLER_AGENT_ID);
  });
});
