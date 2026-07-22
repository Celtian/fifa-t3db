import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openEditableFifaDatabase, openFifaDatabase } from "../src/index.js";
import { requireValue } from "../src/error.js";
import { inspectDatabaseLayout, referenceFifaCrc, tableBytes } from "./parity-helpers.js";

const databaseBytes = readFileSync(new URL("../example/fifa_ng_db.db", import.meta.url));
const metadataXml = readFileSync(new URL("../example/fifa_ng_db-meta.xml", import.meta.url), "utf8");

describe("editable FIFA database", () => {
  test("no-op serialization is byte-for-byte identical and returns owned bytes", () => {
    const editor = openEditableFifaDatabase({ database: databaseBytes, metadataXml });
    const output = editor.serialize();
    expect(Buffer.compare(output, databaseBytes)).toBe(0);
    expect(output).not.toBe(databaseBytes);
    output[0] = 0;
    expect(databaseBytes[0]).toBe(0x44);
  });

  test("selects XML, index, inferred, and non-unique compound keys deterministically", () => {
    const editor = openEditableFifaDatabase({ database: databaseBytes, metadataXml });
    expect(editor.getKeyDefinition("players")).toEqual({
      fields: ["playerid"], source: "xml", unique: true,
    });
    expect(editor.getKeyDefinition("teamkits")).toEqual({
      fields: ["teamkittypetechid", "year", "teamtechid"], source: "index", unique: true,
    });
    expect(editor.getKeyDefinition("rivals")).toEqual({
      fields: ["teamid1", "teamid2"], source: "inferred", unique: true,
    });
    expect(editor.getKeyDefinition("leaguerefereelinks")).toEqual({
      fields: ["leagueid", "refereeid"], source: "inferred", unique: false,
    });

    const frozen = editor.getKeyDefinition("rivals");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.fields)).toBe(true);
    const row = editor.readTable("rivals").rows[0];
    if (row === undefined) throw new Error("Fixture has no rivals");
    editor.deleteRow("rivals", {
      teamid1: requireValue(row.teamid1, "rivals teamid1"),
      teamid2: requireValue(row.teamid2, "rivals teamid2"),
    });
    expect(editor.getKeyDefinition("rivals")).toBe(frozen);
  });

  test("rejects ambiguous duplicate tuples while allowing unique tuples in the same table", () => {
    const editor = openEditableFifaDatabase({ database: databaseBytes, metadataXml });
    const rows = editor.readTable("leaguerefereelinks").rows;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = refereeLinkKey(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicate = rows.find((row) => (counts.get(refereeLinkKey(row)) ?? 0) > 1);
    const unique = rows.find((row) => counts.get(refereeLinkKey(row)) === 1);
    if (duplicate === undefined || unique === undefined) throw new Error("Fixture lacks expected key cases");

    expect(() => editor.updateRow("leaguerefereelinks", {
      leagueid: requireValue(duplicate.leagueid, "duplicate leagueid"),
      refereeid: requireValue(duplicate.refereeid, "duplicate refereeid"),
    }, {})).toThrow(/ambiguous/i);
    expect(editor.updateRow("leaguerefereelinks", {
      leagueid: requireValue(unique.leagueid, "unique leagueid"),
      refereeid: requireValue(unique.refereeid, "unique refereeid"),
    }, {})).toEqual(unique);
  });

  test("updates, inserts, deletes, serializes, and reopens all tables", () => {
    const editor = openEditableFifaDatabase({ database: databaseBytes, metadataXml });
    const originalPlayerCount = editor.readTable("playernames").rows.length;
    const immutableRow = editor.readTable("players").rows[0];
    expect(Object.isFrozen(immutableRow)).toBe(true);

    editor.updateRow("players", { playerid: 1 }, { overallrating: 87 });
    editor.updateRow("version", { artificialkey: 0 }, {
      major: 2,
      exportdate: 160_703,
      schema: "0123456789abcdef0123456789abcdef01234567",
    });
    editor.updateRow("formations", { formationid: 1 }, { midfielders: 3.25 });
    editor.updateRow("playernames", { nameid: 1 }, { name: "Žluťoučký kůň" });
    editor.deleteRow("playernames", { nameid: 0 });
    editor.insertRow("playernames", { nameid: 28_999, name: "新しい名", commentaryid: 900_000 });

    expect(editor.readTable("players").rows[0]).toMatchObject({ playerid: 1, overallrating: 87 });
    expect(editor.readTable("playernames").rows).toHaveLength(originalPlayerCount);
    expect(editor.listTables().find((table) => table.name === "playernames")).toMatchObject({
      writtenRecordCount: originalPlayerCount,
      cancelledRecordCount: 0,
    });

    const output = editor.serialize();
    expect(output).not.toEqual(databaseBytes);
    verifyAllCrcs(output);
    expect(Buffer.compare(tableBytes(output, "onMQ"), tableBytes(databaseBytes, "onMQ"))).toBe(0);

    const reopened = openFifaDatabase({ database: output, metadataXml });
    expect(reopened.readTable("players").rows[0]).toMatchObject({ playerid: 1, overallrating: 87 });
    expect(reopened.readTable("version").rows[0]).toMatchObject({
      major: 2,
      exportdate: 160_703,
      schema: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(reopened.readTable("formations").rows[0]).toMatchObject({ midfielders: 3.25 });
    expect(reopened.readTable("playernames").rows.find((row) => row.nameid === 1)).toMatchObject({
      name: "Žluťoučký kůň",
    });
    expect(reopened.readTable("playernames").rows.at(-1)).toEqual({
      nameid: 28_999, name: "新しい名", commentaryid: 900_000,
    });
    expect(reopened.readTable("playernames").rows.some((row) => row.nameid === 0)).toBe(false);

    let totalRows = 0;
    for (const info of reopened.listTables()) totalRows += reopened.readTable(info.shortName).rows.length;
    expect(totalRows).toBe(109_169);
  });

  test("enforces exact keys, immutable identities, complete rows, ranges, and capacities", () => {
    const editor = openEditableFifaDatabase({ database: databaseBytes, metadataXml });
    expect(editor.readTable("players")).toBe(editor.readTable("players"));
    expect(() => editor.updateRow("players", {}, { overallrating: 1 })).toThrow(/exactly: playerid/i);
    expect(() => editor.updateRow("players", { playerid: 1, extra: 2 }, {})).toThrow(/exactly: playerid/i);
    expect(() => editor.updateRow("players", null as never, {})).toThrow(/composite key must be an object/i);
    expect(() => editor.updateRow("players", { playerid: 1 }, null as never)).toThrow(/changes must be an object/i);
    expect(() => editor.updateRow("players", { playerid: 1 }, { missing: 1 })).toThrow(/unknown field/i);
    expect(() => editor.updateRow("players", { playerid: 1 }, { playerid: 2 })).toThrow(/immutable/i);
    expect(() => editor.updateRow("players", { playerid: 1 }, { overallrating: 1000 })).toThrow(/range/i);
    expect(() => editor.updateRow("players", { playerid: 1 }, { overallrating: 1.5 })).toThrow(/safe integer/i);
    expect(() => editor.updateRow("formations", { formationid: 1 }, { midfielders: Number.POSITIVE_INFINITY }))
      .toThrow(/finite number/i);
    expect(() => editor.updateRow("formations", { formationid: 1 }, { midfielders: Number.MAX_VALUE }))
      .toThrow(/float32 range/i);
    expect(() => editor.updateRow("playernames", { nameid: 1 }, { name: 1 })).toThrow(/expected a string/i);
    expect(() => editor.updateRow("playernames", { nameid: 1 }, { name: "x".repeat(77) })).toThrow(/capacity/i);
    expect(() => editor.updateRow("version", { artificialkey: 0 }, { schema: "bad\0value" })).toThrow(/NUL bytes/i);
    expect(() => editor.insertRow("playernames", null as never)).toThrow(/row must be an object/i);
    expect(() => editor.insertRow("playernames", {
      nameid: 28_999, name: "unknown", commentaryid: 900_000, missing: 1,
    })).toThrow(/unknown field/i);
    expect(() => editor.insertRow("playernames", { nameid: 28_999, name: "missing commentary" }))
      .toThrow(/missing field/i);
    expect(() => editor.insertRow("playernames", {
      nameid: 1, name: "duplicate", commentaryid: 900_000,
    })).toThrow(/duplicate key/i);
    expect(() => editor.deleteRow("players", { playerid: 999_999 })).toThrow(/range/i);
    expect(() => editor.deleteRow("players", { playerid: 499_999 })).toThrow(/does not match/i);
  });
});

function verifyAllCrcs(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = inspectDatabaseLayout(bytes);
  expect(view.getUint32(20, true), "header CRC").toBe(referenceFifaCrc(bytes.subarray(0, 20)));
  expect(view.getUint32(layout.directoryCrcOffset, true), "directory CRC")
    .toBe(referenceFifaCrc(bytes.subarray(24, layout.directoryCrcOffset)));

  for (const [index, table] of layout.tables.entries()) {
    expect(view.getUint32(table.offset + 32, true), `table ${String(index)} header CRC`)
      .toBe(referenceFifaCrc(bytes.subarray(table.offset, table.offset + 32)));
    expect(view.getUint32(table.recordsCrcOffset, true), `table ${String(index)} records CRC`)
      .toBe(referenceFifaCrc(bytes.subarray(table.offset + 36, table.recordsCrcOffset)));
  }
}

function refereeLinkKey(row: Readonly<Record<string, number | string>>): string {
  return `${String(requireValue(row.leagueid, "leagueid"))}:${String(requireValue(row.refereeid, "refereeid"))}`;
}
