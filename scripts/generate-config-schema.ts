import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { format } from "oxfmt";
import { BitesConfigSchema } from "../packages/ext/config.js";

const path = new URL("../pi-bites.schema.json", import.meta.url);
const json = JSON.stringify(
  BitesConfigSchema,
  (_key, value: unknown) => {
    // Editor validation is strict; runtime keeps unknown settings for compatibility.
    if (typeof value === "object" && value !== null && "type" in value && value.type === "object") {
      return { ...value, additionalProperties: false };
    }
    return value;
  },
  2,
);
const { code, errors } = await format("pi-bites.schema.json", json);
if (errors.length) throw new Error(`Schema formatting failed: ${JSON.stringify(errors)}`);

if (process.argv.includes("--check")) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== code) {
    console.error(
      "pi-bites.schema.json is stale. Run bun run schema:generate and commit the result.",
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(path, code);
}
