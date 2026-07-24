import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { EngineConfig } from "../config.ts";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
// The raw postgres-js handle, needed for the dense (pgvector) channel whose
// per-model embedding tables have no Drizzle schema.
export type RawSql = ReturnType<typeof postgres>;

export type DbHandles = {
  db: Db;
  sql: RawSql;
};

export function createDb(config: EngineConfig): DbHandles {
  const sql = postgres(config.databaseUrl, { max: config.dbPoolMax });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
