import { describe, expect, it } from "bun:test";
import { computeAuthority, type AuthoritySignals } from "./authority.ts";

function signals(overrides: Partial<AuthoritySignals> = {}): AuthoritySignals {
  return {
    createdByKind: "human",
    actorCount: 1,
    sourceClass: "native",
    hasSocialSignal: false,
    ...overrides,
  };
}

describe("computeAuthority", () => {
  it("returns a score within [0, 1] for the weakest possible signals", () => {
    const score = computeAuthority(
      signals({ createdByKind: "adapter", sourceClass: "record" }),
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns 1.0 for the strongest possible signals (weights sum to 1.0)", () => {
    const score = computeAuthority(
      signals({
        createdByKind: "human",
        actorCount: 8,
        sourceClass: "channel",
        hasSocialSignal: true,
      }),
    );
    expect(score).toBeCloseTo(1.0, 5);
  });

  // Canonical example: a solo single-author note must score LOWER than a
  // multi-party channel thread, even though both are human-authored — the
  // actor_count + source_class axes carry the discriminating signal, not
  // created_by_kind alone.
  it("scores a solo native artifact lower than a multi-party channel thread", () => {
    const soloArtifact = computeAuthority(
      signals({ createdByKind: "human", actorCount: 1, sourceClass: "native" }),
    );
    const multiPartyThread = computeAuthority(
      signals({ createdByKind: "human", actorCount: 5, sourceClass: "channel" }),
    );
    expect(soloArtifact).toBeLessThan(multiPartyThread);
  });

  it("actor_count is log-scaled: 1 -> 2 actors moves the score more than 7 -> 8", () => {
    const at1 = computeAuthority(signals({ actorCount: 1 }));
    const at2 = computeAuthority(signals({ actorCount: 2 }));
    const at7 = computeAuthority(signals({ actorCount: 7 }));
    const at8 = computeAuthority(signals({ actorCount: 8 }));
    expect(at2 - at1).toBeGreaterThan(at8 - at7);
  });

  it("actor_count saturates at the log cap — 8 and 100 score identically", () => {
    const at8 = computeAuthority(signals({ actorCount: 8 }));
    const at100 = computeAuthority(signals({ actorCount: 100 }));
    expect(at100).toBeCloseTo(at8, 10);
  });

  it("treats a sub-1 or fractional actor_count as a solo actor (floor of 1)", () => {
    const at0 = computeAuthority(signals({ actorCount: 0 }));
    const at1 = computeAuthority(signals({ actorCount: 1 }));
    expect(at0).toBe(at1);
  });

  it("orders created_by_kind priors human > agent > system > adapter", () => {
    const human = computeAuthority(signals({ createdByKind: "human" }));
    const agent = computeAuthority(signals({ createdByKind: "agent" }));
    const system = computeAuthority(signals({ createdByKind: "system" }));
    const adapter = computeAuthority(signals({ createdByKind: "adapter" }));
    expect(human).toBeGreaterThan(agent);
    expect(agent).toBeGreaterThan(system);
    expect(system).toBeGreaterThan(adapter);
  });

  it("orders source_class priors channel > thread > call > native > record", () => {
    const channel = computeAuthority(signals({ sourceClass: "channel" }));
    const thread = computeAuthority(signals({ sourceClass: "thread" }));
    const call = computeAuthority(signals({ sourceClass: "call" }));
    const native = computeAuthority(signals({ sourceClass: "native" }));
    const record = computeAuthority(signals({ sourceClass: "record" }));
    expect(channel).toBeGreaterThan(thread);
    expect(thread).toBeGreaterThan(call);
    expect(call).toBeGreaterThan(native);
    expect(native).toBeGreaterThan(record);
  });

  it("a social signal bump strictly increases the score, all else equal", () => {
    const without = computeAuthority(signals({ hasSocialSignal: false }));
    const withSignal = computeAuthority(signals({ hasSocialSignal: true }));
    expect(withSignal).toBeGreaterThan(without);
  });
});
