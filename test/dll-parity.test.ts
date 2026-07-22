import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openFifaDatabase } from "../src/index.js";
import { requireValue } from "../src/error.js";
import { fifaCrc } from "../src/writer.js";
import { inspectDatabaseLayout, referenceFifaCrc } from "./parity-helpers.js";

const databaseBytes = readFileSync(new URL("../example/fifa_ng_db.db", import.meta.url));
const metadataXml = readFileSync(new URL("../example/fifa_ng_db-meta.xml", import.meta.url), "utf8");
const dllBytes = readFileSync(new URL("../FifaLibrary16.dll", import.meta.url));

describe("FifaLibrary16.dll parity anchors", () => {
  test("uses the exact DLL revision that was statically audited", () => {
    expect(createHash("sha256").update(dllBytes).digest("hex")).toBe(
      "711356a2cf7a87451940c84088bdfa0a7b512bc3651bf0b03a89179195cae957",
    );
  });

  test("matches the DLL ComputeCrcDb11 algorithm and fixture constants", () => {
    expect(fifaCrc(new TextEncoder().encode("123456789"))).toBe(0x0376e6e7);
    expect(referenceFifaCrc(new TextEncoder().encode("123456789"))).toBe(0x0376e6e7);

    const database = openFifaDatabase({ database: databaseBytes, metadataXml });
    expect(database.header.headerCrc).toBe(699_832_269);
    expect(database.header.shortNamesCrc).toBe(1_905_446_261);
    expect(database.readTable("version").info).toMatchObject({
      headerCrc: 1_902_485_309,
      recordsCrc: 2_652_247_201,
    });
    expect(database.readTable("playernames").info).toMatchObject({
      headerCrc: 2_715_420_698,
      recordsCrc: 2_526_132_267,
    });
  });

  test("validates every stored fixture CRC with an independent implementation", () => {
    const view = new DataView(databaseBytes.buffer, databaseBytes.byteOffset, databaseBytes.byteLength);
    const layout = inspectDatabaseLayout(databaseBytes);
    expect(view.getUint32(20, true)).toBe(referenceFifaCrc(databaseBytes.subarray(0, 20)));
    expect(view.getUint32(layout.directoryCrcOffset, true))
      .toBe(referenceFifaCrc(databaseBytes.subarray(24, layout.directoryCrcOffset)));

    for (const table of layout.tables) {
      expect(view.getUint32(table.offset + 32, true), `${table.shortName} header`)
        .toBe(referenceFifaCrc(databaseBytes.subarray(table.offset, table.offset + 32)));
      expect(view.getUint32(table.recordsCrcOffset, true), `${table.shortName} records`)
        .toBe(referenceFifaCrc(databaseBytes.subarray(table.offset + 36, table.recordsCrcOffset)));
    }
  });

  test("uses the DLL field identifiers and padded compressed-block CRC location", () => {
    const database = openFifaDatabase({ database: databaseBytes, metadataXml });
    const storageTypes = new Set(database.listTables().flatMap((table) => table.fields.map((field) => field.storageType)));
    expect(storageTypes).toEqual(new Set([0, 3, 4, 13]));
    expect(database.readTable("version").info.fields.find((field) => field.name === "exportdate"))
      .toMatchObject({ storageType: 3, type: "DBOFIELDTYPE_DATE" });

    const audio = database.readTable("audionation").info;
    const rawCompressedEnd = audio.offset + 36 + audio.fieldCount * 16
      + audio.writtenRecordCount * audio.recordSize + audio.compressedStringLength;
    const binaryAudio = inspectDatabaseLayout(databaseBytes).tables.find((table) => table.shortName === audio.shortName);
    expect(binaryAudio).toBeDefined();
    expect(requireValue(binaryAudio, "audionation layout").recordsCrcOffset - rawCompressedEnd).toBe(2);
  });
});
