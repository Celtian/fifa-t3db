import { readFileSync } from "node:fs";
import { openFifaDatabase } from "./src/index.js";

const database = openFifaDatabase({
  database: readFileSync(new URL("./example/fifa_ng_db.db", import.meta.url)),
  metadataXml: readFileSync(new URL("./example/fifa_ng_db-meta.xml", import.meta.url), "utf8"),
});

const leagues = database.readTable("leagues");

console.log(`${leagues.info.name} (${String(leagues.rows.length)} rows)`);
console.table(leagues.rows);
