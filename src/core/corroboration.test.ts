import { describe, expect, it } from "bun:test";
import {
  corroborationFactor,
  CORROBORATION_STRONG_FLOOR,
  effectiveAuthority,
  meetsStrongEvidenceGate,
} from "./corroboration.ts";
import {
  BOOST_MULTIPLIER_MAX,
  BOOST_MULTIPLIER_MIN,
} from "./hybrid-search.ts";

describe("corroborationFactor", () => {
  it("is neutral with no edges", () => {
    expect(corroborationFactor({ supports: 0, contradicts: 0 })).toBe(1);
  });

  it("raises rank with independent supports", () => {
    const none = corroborationFactor({ supports: 0, contradicts: 0 });
    const one = corroborationFactor({ supports: 1, contradicts: 0 });
    const many = corroborationFactor({ supports: 4, contradicts: 0 });
    expect(one).toBeGreaterThan(none);
    expect(many).toBeGreaterThan(one);
    expect(many).toBeLessThanOrEqual(BOOST_MULTIPLIER_MAX);
  });

  it("lowers rank with contradictions without zeroing", () => {
    const base = corroborationFactor({ supports: 0, contradicts: 0 });
    const hit = corroborationFactor({ supports: 0, contradicts: 2 });
    expect(hit).toBeLessThan(base);
    expect(hit).toBeGreaterThanOrEqual(BOOST_MULTIPLIER_MIN);
  });

  it("stays inside the boost envelope", () => {
    for (const s of [0, 1, 2, 8, 100]) {
      for (const c of [0, 1, 2, 8, 100]) {
        const f = corroborationFactor({ supports: s, contradicts: c });
        expect(f).toBeGreaterThanOrEqual(BOOST_MULTIPLIER_MIN);
        expect(f).toBeLessThanOrEqual(BOOST_MULTIPLIER_MAX);
      }
    }
  });
});

describe("effectiveAuthority", () => {
  it("scales the capture snapshot without mutating the formula range", () => {
    const snap = 0.8;
    const raised = effectiveAuthority(snap, { supports: 4, contradicts: 0 });
    const lowered = effectiveAuthority(snap, { supports: 0, contradicts: 4 });
    expect(raised).toBeGreaterThan(snap * 0.99);
    expect(lowered).toBeLessThan(snap);
    expect(raised).toBeLessThanOrEqual(1);
    expect(lowered).toBeGreaterThanOrEqual(0);
  });
});

describe("meetsStrongEvidenceGate", () => {
  const floor = 0.3;

  it("rejects low authority even with supports", () => {
    expect(
      meetsStrongEvidenceGate({
        authority: 0.1,
        supports: 10,
        authorityFloor: floor,
      }),
    ).toBe(false);
  });

  it("accepts stated human above authority floor without supports", () => {
    expect(
      meetsStrongEvidenceGate({
        authority: 0.5,
        supports: 0,
        provenance: "stated",
        createdByKind: "human",
        authorityFloor: floor,
      }),
    ).toBe(true);
  });

  it("accepts corroboration at the strong floor", () => {
    expect(
      meetsStrongEvidenceGate({
        authority: 0.5,
        supports: CORROBORATION_STRONG_FLOOR,
        provenance: "inferred",
        createdByKind: "agent",
        authorityFloor: floor,
      }),
    ).toBe(true);
  });

  it("rejects inferred agent below corroboration floor", () => {
    expect(
      meetsStrongEvidenceGate({
        authority: 0.5,
        supports: CORROBORATION_STRONG_FLOOR - 1,
        provenance: "inferred",
        createdByKind: "agent",
        authorityFloor: floor,
      }),
    ).toBe(false);
  });
});
