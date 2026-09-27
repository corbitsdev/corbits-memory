import { loadMemoryConfig } from "../src/mount-config.js";
import { runMemoryMigrations } from "../src/migrations.js";

const { memory } = loadMemoryConfig();
const url = new URL(memory.databaseUrl);
const sslmode = url.searchParams.get("sslmode");

await runMemoryMigrations(
  {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl:
      sslmode === "require" ||
      sslmode === "verify-ca" ||
      sslmode === "verify-full",
  },
  { schema: "public", ftsLanguage: memory.ftsLanguage },
);
console.log("Migrations complete.");
