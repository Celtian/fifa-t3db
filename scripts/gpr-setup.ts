import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packagePath = join(projectRoot, "dist", "package.json");
const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (!isRecord(parsed)) {
  throw new TypeError(`Expected ${packagePath} to contain a JSON object`);
}

const packageJson = parsed;
if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
  throw new TypeError(`Expected ${packagePath} to contain a package name`);
}

const unscopedName = packageJson.name.includes("/")
  ? packageJson.name.slice(packageJson.name.lastIndexOf("/") + 1)
  : packageJson.name;

packageJson.name = `@celtian/${unscopedName}`;
packageJson.publishConfig = {
  registry: "https://npm.pkg.github.com",
};

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Prepared ${String(packageJson.name)} for GitHub Packages`);
