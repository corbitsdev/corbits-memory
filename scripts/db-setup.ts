import { runMemoryMigrations } from "../src/migrations.ts";

const url =
  process.env["KNOWLEDGE_DATABASE_URL"];
if (!url) throw new Error("KNOWLEDGE_DATABASE_URL is required");

await runMemoryMigrations(url, {
  log: (line) => console.log(`  ${line}`),
});
console.log("Migrations complete.");
