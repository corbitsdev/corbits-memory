import { runMemoryMigrations } from "../src/migrations.ts";

const url =
  process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required");

await runMemoryMigrations(url, {
  log: (line) => console.log(`  ${line}`),
});
console.log("Migrations complete.");
