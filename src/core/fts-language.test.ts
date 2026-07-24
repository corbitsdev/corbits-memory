import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createFtsVerification,
  DEFAULT_FTS_LANGUAGE,
  FTS_LANGUAGE_TOKEN,
  parseFtsLanguage,
  verifyFtsLanguage,
} from "./fts-language.ts";

describe("parseFtsLanguage", () => {
  it("defaults when unset or empty", () => {
    expect(parseFtsLanguage(undefined)).toBe(DEFAULT_FTS_LANGUAGE);
    expect(parseFtsLanguage("")).toBe(DEFAULT_FTS_LANGUAGE);
  });

  it("accepts plain lowercase config names", () => {
    expect(parseFtsLanguage("german")).toBe("german");
    expect(parseFtsLanguage("simple")).toBe("simple");
  });

  it("rejects anything that is not a plain lowercase identifier", () => {
    expect(() => parseFtsLanguage("English")).toThrow();
    expect(() => parseFtsLanguage("en-US")).toThrow();
    expect(() => parseFtsLanguage("english'; DROP TABLE x; --")).toThrow();
  });
});

describe("the chunk migration language token", () => {
  it("is present in the generated-column DDL, ready for substitution", async () => {
    const ddl = await readFile(
      join(import.meta.dir, "..", "..", "migrations", "0004_knowledge_chunk.sql"),
      "utf8",
    );
    expect(ddl).toContain(`to_tsvector('${FTS_LANGUAGE_TOKEN}', "text")`);
    expect(ddl.replaceAll(FTS_LANGUAGE_TOKEN, "german")).toContain(
      "to_tsvector('german', \"text\")",
    );
  });
});

describe("runKnowledgeMigrations language boundary", () => {
  it("falls back to the FTS_LANGUAGE env var when no option is passed", async () => {
    // Pin the boundary contract without a live database: the runner must
    // resolve exactly like the config loader, from the same env var.
    const { runKnowledgeMigrations } = await import("../migrations.ts");
    process.env["FTS_LANGUAGE"] = "not a valid name";
    try {
      await expect(runKnowledgeMigrations("postgres://unused")).rejects.toThrow(
        "not a valid text search config name",
      );
    } finally {
      delete process.env["FTS_LANGUAGE"];
    }
  });
});

describe("verifyFtsLanguage", () => {
  function fakeClient(opts: { known?: boolean; expr?: string | null }) {
    return {
      query: (sqlText: string) => {
        if (sqlText.includes("pg_ts_config")) {
          return Promise.resolve(opts.known === false ? [] : [{ "?column?": 1 }]);
        }
        return Promise.resolve(opts.expr == null ? [] : [{ expr: opts.expr }]);
      },
    };
  }

  const ENGLISH_EXPR = "to_tsvector('english'::regconfig, text)";

  it("passes when the column language matches the configured one", async () => {
    await verifyFtsLanguage(fakeClient({ expr: ENGLISH_EXPR }), "english");
  });

  it("throws when the configured language is not an installed config", async () => {
    await expect(
      verifyFtsLanguage(fakeClient({ known: false, expr: ENGLISH_EXPR }), "klingon"),
    ).rejects.toThrow("not an installed");
  });

  it("throws with a rebuild instruction on language mismatch", async () => {
    await expect(
      verifyFtsLanguage(fakeClient({ expr: ENGLISH_EXPR }), "german"),
    ).rejects.toThrow('built with "english"');
  });

  it("throws when the column has no generation expression", async () => {
    await expect(
      verifyFtsLanguage(fakeClient({ expr: null }), "english"),
    ).rejects.toThrow("schema not migrated");
  });
});

describe("createFtsVerification", () => {
  const ENGLISH_EXPR = "to_tsvector('english'::regconfig, text)";

  it("verifies once and memoizes success", async () => {
    let calls = 0;
    const ensure = createFtsVerification(
      {
        query: (sqlText: string) => {
          calls += 1;
          return Promise.resolve(
            sqlText.includes("pg_ts_config") ? [{ ok: 1 }] : [{ expr: ENGLISH_EXPR }],
          );
        },
      },
      "english",
    );
    await ensure();
    await ensure();
    // one pg_ts_config lookup + one catalog read, never repeated
    expect(calls).toBe(2);
  });

  it("clears the memo on failure so a transient error does not poison the plane", async () => {
    let attempt = 0;
    const ensure = createFtsVerification(
      {
        query: (sqlText: string) => {
          if (attempt === 0 && sqlText.includes("pg_ts_config")) {
            attempt += 1;
            return Promise.reject(new Error("connection refused"));
          }
          return Promise.resolve(
            sqlText.includes("pg_ts_config") ? [{ ok: 1 }] : [{ expr: ENGLISH_EXPR }],
          );
        },
      },
      "english",
    );
    await expect(ensure()).rejects.toThrow("connection refused");
    await ensure();
  });

  it("keeps throwing on a real mismatch", async () => {
    const ensure = createFtsVerification(
      {
        query: (sqlText: string) =>
          Promise.resolve(
            sqlText.includes("pg_ts_config") ? [{ ok: 1 }] : [{ expr: ENGLISH_EXPR }],
          ),
      },
      "german",
    );
    await expect(ensure()).rejects.toThrow('built with "english"');
    await expect(ensure()).rejects.toThrow('built with "english"');
  });
});

describe("createFtsVerification concurrency", () => {
  const ENGLISH_EXPR = "to_tsvector('english'::regconfig, text)";

  it("concurrent first calls share one in-flight verification", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ensure = createFtsVerification(
      {
        query: async (sqlText: string) => {
          calls += 1;
          await gate;
          return sqlText.includes("pg_ts_config") ? [{ ok: 1 }] : [{ expr: ENGLISH_EXPR }];
        },
      },
      "english",
    );
    const a = ensure();
    const b = ensure();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(2);
  });

  it("concurrent callers all see a shared failure, then a retry succeeds", async () => {
    let attempt = 0;
    const ensure = createFtsVerification(
      {
        query: (sqlText: string) => {
          if (attempt === 0 && sqlText.includes("pg_ts_config")) {
            attempt += 1;
            return Promise.reject(new Error("connection refused"));
          }
          return Promise.resolve(
            sqlText.includes("pg_ts_config") ? [{ ok: 1 }] : [{ expr: ENGLISH_EXPR }],
          );
        },
      },
      "english",
    );
    const a = ensure();
    const b = ensure();
    await expect(a).rejects.toThrow("connection refused");
    await expect(b).rejects.toThrow("connection refused");
    await ensure();
  });
});
