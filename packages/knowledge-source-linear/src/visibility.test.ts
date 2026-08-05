import { describe, expect, it } from "bun:test";
import {
  collectPrincipalIds,
  isPrivateIssue,
  mapIssueVisibility,
} from "./visibility.ts";
import type { LinearIssueData } from "./types.ts";

const base: LinearIssueData = {
  id: "i1",
  identifier: "CL-1",
  title: "t",
  creatorId: "c1",
  assigneeId: "a1",
  subscriberIds: ["c1", "a1", "s1"],
};

describe("mapIssueVisibility", () => {
  it("team-visible → tenant, never source_acl", () => {
    const v = mapIssueVisibility({
      ...base,
      private: false,
      team: { private: false },
    });
    expect(v).toEqual({ mode: "tenant" });
  });

  it("private multi-principal → principals (never tenant)", () => {
    const v = mapIssueVisibility({ ...base, private: true });
    expect(v.mode).toBe("principals");
    expect(v.mode).not.toBe("tenant");
    expect(v.principalIds).toEqual(["c1", "a1", "s1"]);
  });

  it("private single principal → private mode", () => {
    const v = mapIssueVisibility({
      id: "i2",
      creatorId: "solo",
      assigneeId: "solo",
      subscriberIds: ["solo"],
      private: true,
    });
    expect(v).toEqual({ mode: "private", principalIds: ["solo"] });
  });

  it("team.private without issue.private is still private", () => {
    expect(
      isPrivateIssue({
        id: "i3",
        private: false,
        team: { private: true },
      }),
    ).toBe(true);
    const v = mapIssueVisibility({
      id: "i3",
      creatorId: "c",
      private: false,
      team: { private: true },
    });
    expect(v.mode).not.toBe("tenant");
  });
});

describe("collectPrincipalIds", () => {
  it("dedupes creator/assignee/subscribers and nested objects", () => {
    const ids = collectPrincipalIds({
      id: "x",
      creatorId: "a",
      assigneeId: "b",
      subscriberIds: ["a", "c"],
      creator: { id: "a" },
      assignee: { id: "b" },
    });
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });
});
