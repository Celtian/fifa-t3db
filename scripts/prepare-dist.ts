import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const distDirectory = join(projectRoot, "dist");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new TypeError(`Expected ${path} to contain a JSON object`);
  }
  return parsed;
}

await mkdir(distDirectory, { recursive: true });

const packageJson = await readPackageJson(join(projectRoot, "package.json"));
delete packageJson.scripts;
delete packageJson.devDependencies;
delete packageJson["lint-staged"];
delete packageJson["auto-changelog"];
delete packageJson.packageManager;
delete packageJson.files;

packageJson.main = "./index.js";
packageJson.types = "./index.d.ts";
packageJson.exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js",
    default: "./index.js",
  },
};

await writeFile(join(distDirectory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

const documents = [
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
] as const;

await Promise.all(
  documents.map(async (document) => cp(join(projectRoot, document), join(distDirectory, document))),
);

const distDocs = join(distDirectory, "docs");
await rm(distDocs, { recursive: true, force: true });
await cp(join(projectRoot, "docs"), distDocs, { recursive: true });

console.log(`Prepared npm package in ${distDirectory}`);
