import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FifaDatabaseError, openEditableFifaDatabase, openFifaDatabase } from "../src/index.js";

const databaseBytes = readFileSync(new URL("../example/fifa_ng_db.db", import.meta.url));
const metadataXml = readFileSync(new URL("../example/fifa_ng_db-meta.xml", import.meta.url), "utf8");

describe("reference database fixture", () => {
  const database = openFifaDatabase({ database: databaseBytes, metadataXml });

  test("indexes the database header and all tables", () => {
    expect(database.header.declaredFileSize).toBe(4_433_528);
    expect(database.header.tableCount).toBe(137);
    expect(database.header.platform).toBe(0);
    expect(database.listTables()).toHaveLength(137);
    expect(database.listTables().find((table) => table.name === "players")).toMatchObject({
      shortName: "CZUM",
      recordCount: 22_359,
      fieldCount: 105,
    });
  });

  test("decodes fixed strings and packed values from the version table", () => {
    const version = database.readTable("version");
    expect(version.rows).toHaveLength(1);
    expect(version.rows[0]).toMatchObject({
      artificialkey: 0,
      major: 1,
      minor: 1,
      exportdate: 160_702,
      isonline: 0,
      schema: "eba788b4771e5282f8f43b9c5ad83d9563c20e57",
    });
  });

  test("decodes representative integer rows", () => {
    const attendance = database.readTable("BigAttendance");
    expect(attendance.rows.slice(0, 3)).toEqual([
      { emotion: 0, min: 0, max: 6 },
      { emotion: 1, min: 0, max: 6 },
      { emotion: 2, min: 0, max: 7 },
    ]);

    const players = database.readTable("players");
    expect(players.rows).toHaveLength(22_359);
    expect(players.rows[0]).toMatchObject({ playerid: 1, overallrating: 88 });
  });

  test("decodes Huffman-compressed player names and memoizes tables", () => {
    const names = database.readTable("BGwe");
    expect(names.rows).toHaveLength(25_294);
    expect(names.rows[1]).toMatchObject({ nameid: 1, name: "de Souza Mendes" });
    expect(database.readTable("playernames")).toBe(names);
  });

  test("decodes Huffman-compressed audio language names", () => {
    const nations = database.readTable("audionation");
    expect(nations.rows.slice(0, 3).map((row) => row.defaultcommlang)).toEqual([
      "eng_us",
      "rus_ru",
      "spa_es",
    ]);
  });

  test("materializes every table and every valid fixture record", () => {
    let totalRows = 0;
    for (const info of database.listTables()) {
      const table = database.readTable(info.shortName);
      expect(table.rows).toHaveLength(info.validRecordCount);
      totalRows += table.rows.length;
    }
    expect(totalRows).toBe(109_169);
  });
});

describe("field encodings", () => {
  test("decodes cross-byte integers, negative ranges, floats, fixed strings, and invalid records", () => {
    const record = new Uint8Array(9);
    const encodedInteger = 13;
    record[0] = (encodedInteger << 5) & 0xff;
    record[1] = encodedInteger >> 3;
    record.set(new TextEncoder().encode("OK"), 2);
    new DataView(record.buffer).setFloat32(4, 12.5, true);
    const invalid = record.slice();
    invalid[8] = 0x80;

    const fixture = buildDatabase({
      recordSize: 9,
      cancelledRecordCount: 1,
      fields: [
        field("crossing", "bits", "DBOFIELDTYPE_INTEGER", 3, 5, 6, -4, 59),
        field("label", "text", "DBOFIELDTYPE_STRING", 0, 16, 16),
        field("rating", "real", "DBOFIELDTYPE_REAL", 4, 32, 32),
      ],
      records: [record, invalid],
    });
    const table = openFifaDatabase(fixture).readTable("synthetic");

    expect(table.info.validRecordCount).toBe(1);
    expect(table.rows).toEqual([{ crossing: 9, label: "OK", rating: 12.5 }]);
  });

  test("decodes one-byte and two-byte Huffman length variants", () => {
    const record = new Uint8Array(9);
    new DataView(record.buffer).setInt32(0, 4, true);
    new DataView(record.buffer).setInt32(4, 6, true);
    const compressed = new Uint8Array([
      0, 0x41, 0, 0x42,
      4, 0b0110_0000,
      0, 4, 0b0110_0000,
    ]);
    const fixture = buildDatabase({
      recordSize: 9,
      fields: [
        field("shortText", "strA", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 64),
        field("longText", "strB", "DBOFIELDTYPE_STRING", 14, 32, 32, 0, 0, 64),
      ],
      records: [record],
      compressed,
    });

    expect(openFifaDatabase(fixture).readTable("Test").rows).toEqual([
      { shortText: "ABBA", longText: "ABBA" },
    ]);
  });

  test("writes packed, ranged, float, and fixed fields while compacting invalid records", () => {
    const record = new Uint8Array(9);
    const invalid = record.slice();
    invalid[8] = 0x80;
    const fixture = buildDatabase({
      recordSize: 9,
      cancelledRecordCount: 1,
      fields: [
        field("crossing", "bits", "DBOFIELDTYPE_INTEGER", 3, 5, 6, -4, 59),
        field("label", "text", "DBOFIELDTYPE_STRING", 0, 16, 16),
        field("rating", "real", "DBOFIELDTYPE_REAL", 4, 32, 32),
      ],
      records: [record, invalid],
    });
    const editor = openEditableFifaDatabase(fixture);
    editor.updateRow("Test", {}, { crossing: 59, label: "XY", rating: 1.125 });
    const reopened = openFifaDatabase({ ...fixture, database: editor.serialize() }).readTable("Test");
    expect(reopened.rows).toEqual([{ crossing: 59, label: "XY", rating: 1.125 }]);
    expect(reopened.info).toMatchObject({ recordCount: 1, writtenRecordCount: 1, cancelledRecordCount: 0 });
  });

  test("rebuilds empty, single-symbol, and both compressed length-prefix variants", () => {
    const record = new Uint8Array(9);
    new DataView(record.buffer).setInt32(0, -1, true);
    new DataView(record.buffer).setInt32(4, -1, true);
    const fixture = buildDatabase({
      recordSize: 9,
      fields: [
        field("shortText", "strA", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 2_040),
        field("longText", "strB", "DBOFIELDTYPE_STRING", 14, 32, 32, 0, 0, 4_096),
      ],
      records: [record],
    });

    const oneSymbol = openEditableFifaDatabase(fixture);
    oneSymbol.updateRow("Test", {}, { shortText: "A".repeat(255), longText: "A".repeat(300) });
    expect(openFifaDatabase({ ...fixture, database: oneSymbol.serialize() }).readTable("Test").rows).toEqual([
      { shortText: "A".repeat(255), longText: "A".repeat(300) },
    ]);

    const empty = openEditableFifaDatabase(fixture);
    empty.updateRow("Test", {}, { shortText: "", longText: "" });
    const reopened = openFifaDatabase({ ...fixture, database: empty.serialize() }).readTable("Test");
    expect(reopened.info.compressedStringLength).toBe(0);
    expect(reopened.rows).toEqual([{ shortText: "", longText: "" }]);
  });

  test("decodes raw compressed blocks and empty Huffman outputs", () => {
    const rawRecord = new Uint8Array(5);
    new DataView(rawRecord.buffer).setInt32(0, 0, true);
    const raw = buildDatabase({
      recordSize: 5,
      fields: [field("text", "text", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 64)],
      records: [rawRecord],
      compressed: Uint8Array.of(2, 0x4f, 0x4b),
    });
    expect(openFifaDatabase(raw).readTable("Test").rows).toEqual([{ text: "OK" }]);

    const emptyRecord = new Uint8Array(5);
    new DataView(emptyRecord.buffer).setInt32(0, 4, true);
    const empty = buildDatabase({
      recordSize: 5,
      fields: [field("text", "text", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 64)],
      records: [emptyRecord],
      compressed: Uint8Array.of(0, 0x41, 0, 0x42, 0),
    });
    expect(openFifaDatabase(empty).readTable("Test").rows).toEqual([{ text: "" }]);

    const missingRecord = new Uint8Array(5);
    new DataView(missingRecord.buffer).setInt32(0, -1, true);
    const missing = buildDatabase({
      recordSize: 5,
      fields: [field("text", "text", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 64)],
      records: [missingRecord],
    });
    expect(openFifaDatabase(missing).readTable("Test").rows).toEqual([{ text: "" }]);
  });

  test("rejects malformed Huffman pointers, trees, and streams", () => {
    const fixture = (pointer: number, compressed: Uint8Array) => {
      const record = new Uint8Array(5);
      new DataView(record.buffer).setInt32(0, pointer, true);
      return buildDatabase({
        recordSize: 5,
        fields: [field("text", "text", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 128)],
        records: [record],
        compressed,
      });
    };

    expect(() => openFifaDatabase(fixture(2, Uint8Array.of(0, 0, 0))).readTable("Test"))
      .toThrow(/not aligned/i);
    expect(() => openFifaDatabase(fixture(8, Uint8Array.of(0, 0, 0, 0))).readTable("Test"))
      .toThrow(/tree exceeds/i);
    expect(() => openFifaDatabase(fixture(4, Uint8Array.of(0, 0x41, 0, 0x42, 1))).readTable("Test"))
      .toThrow(/truncated Huffman/i);
    expect(() => openFifaDatabase(fixture(4, Uint8Array.of(2, 0, 0, 0x42, 1, 0))).readTable("Test"))
      .toThrow(/child 2 is outside/i);

    const record = new Uint8Array(9);
    new DataView(record.buffer).setInt32(0, 4, true);
    new DataView(record.buffer).setInt32(4, 8, true);
    const outside = buildDatabase({
      recordSize: 9,
      fields: [
        field("first", "strA", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 64),
        field("second", "strB", "DBOFIELDTYPE_STRING", 13, 32, 32, 0, 0, 64),
      ],
      records: [record],
      compressed: Uint8Array.of(0, 0x41, 0, 0x42, 1, 0),
    });
    expect(() => openFifaDatabase(outside).readTable("Test")).toThrow(/pointer 8 is outside/i);
  });

  test("rejects insertion beyond the uint16 row limit", () => {
    const records = Array.from({ length: 65_535 }, () => new Uint8Array(2));
    const fixture = buildDatabase({
      recordSize: 2,
      fields: [field("value", "valu", "DBOFIELDTYPE_INTEGER", 3, 0, 1, 0, 1)],
      records,
    });
    const editor = openEditableFifaDatabase(fixture);
    expect(() => editor.insertRow("Test", { value: 1 })).toThrow(/cannot exceed 65535 rows/i);
  });

  test("rejects compressed prefixes and packed values that exceed binary storage", () => {
    const shortRecord = new Uint8Array(5);
    new DataView(shortRecord.buffer).setInt32(0, -1, true);
    const shortString = buildDatabase({
      recordSize: 5,
      fields: [field("text", "text", "DBOFIELDTYPE_STRING", 13, 0, 32, 0, 0, 2_048)],
      records: [shortRecord],
    });
    expect(() => openEditableFifaDatabase(shortString).updateRow("Test", {}, { text: "x".repeat(256) }))
      .toThrow(/too long for storage type 13/i);

    const longRecord = new Uint8Array(5);
    new DataView(longRecord.buffer).setInt32(0, -1, true);
    const longString = buildDatabase({
      recordSize: 5,
      fields: [field("text", "text", "DBOFIELDTYPE_STRING", 14, 0, 32, 0, 0, 524_288)],
      records: [longRecord],
    });
    expect(() => openEditableFifaDatabase(longString).updateRow("Test", {}, { text: "x".repeat(65_536) }))
      .toThrow(/too long for storage type 14/i);

    const packed = buildDatabase({
      recordSize: 2,
      fields: [field("value", "valu", "DBOFIELDTYPE_INTEGER", 3, 0, 1, 0, 10)],
      records: [new Uint8Array(2)],
    });
    expect(() => openEditableFifaDatabase(packed).updateRow("Test", {}, { value: 2 }))
      .toThrow(/does not fit 1 packed bits/i);
  });

  test("compares multiple unique XML indices and supports string identity tuples", () => {
    const first = new Uint8Array([0x41, 0, 0]);
    const second = new Uint8Array([0x42, 1, 0]);
    const fixture = buildDatabase({
      recordSize: 3,
      fields: [
        field("label", "text", "DBOFIELDTYPE_STRING", 0, 0, 8),
        field("value", "valu", "DBOFIELDTYPE_INTEGER", 3, 8, 1, 0, 1),
      ],
      records: [first, second],
    });
    const indices = '<indices>'
      + '<index shortname="strI" tableshortname="Test"><indexfields><indexfield shortname="text" /></indexfields></index>'
      + '<index shortname="intI" tableshortname="Test"><indexfields><indexfield shortname="valu" /></indexfields></index>'
      + '</indices>';
    fixture.metadataXml = fixture.metadataXml.replace('<table name="synthetic"', `${indices}<table name="synthetic"`);

    expect(openEditableFifaDatabase(fixture).getKeyDefinition("Test")).toEqual({
      fields: ["label"],
      source: "index",
      unique: true,
    });
  });
});

describe("validation", () => {
  const valid = buildDatabase({
    recordSize: 2,
    fields: [field("value", "valu", "DBOFIELDTYPE_INTEGER", 3, 0, 7, 0, 100)],
    records: [new Uint8Array([42, 0])],
  });

  test("rejects malformed signatures", () => {
    const bytes = valid.database.slice();
    bytes[0] = 0;
    expect(() => openFifaDatabase({ ...valid, database: bytes })).toThrow(/signature/i);
  });

  test("rejects truncated input", () => {
    expect(() => openFifaDatabase({ ...valid, database: valid.database.subarray(0, valid.database.length - 1) }))
      .toThrow(/declared database size/i);
  });

  test("rejects missing XML field descriptors", () => {
    expect(() => openFifaDatabase({
      ...valid,
      metadataXml: valid.metadataXml.replace('shortname="valu"', 'shortname="nope"'),
    })).toThrow(/missing from metadata XML/i);
  });

  test("rejects unknown internal field types with context", () => {
    const bytes = valid.database.slice();
    const descriptorOffset = 36 + 36;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(descriptorOffset, 99, true);
    expect(() => openFifaDatabase({ ...valid, database: bytes })).toThrow(
      /table synthetic .*field value.*unsupported internal storage type 99/i,
    );
  });

  test("rejects unknown table lookups with a typed error", () => {
    const database = openFifaDatabase(valid);
    expect(() => database.readTable("missing")).toThrow(FifaDatabaseError);
    expect(() => database.readTable("missing")).toThrow(/Unknown table/);
  });
});

type XmlType = "DBOFIELDTYPE_DATE" | "DBOFIELDTYPE_INTEGER" | "DBOFIELDTYPE_REAL" | "DBOFIELDTYPE_STRING";

interface SyntheticField {
  name: string;
  shortName: string;
  xmlType: XmlType;
  storageType: number;
  bitOffset: number;
  storageDepth: number;
  xmlDepth: number;
  rangeLow: number;
  rangeHigh: number;
}

function field(
  name: string,
  shortName: string,
  xmlType: XmlType,
  storageType: number,
  bitOffset: number,
  storageDepth: number,
  rangeLow = 0,
  rangeHigh = 0,
  xmlDepth = storageDepth,
): SyntheticField {
  return { name, shortName, xmlType, storageType, bitOffset, storageDepth, xmlDepth, rangeLow, rangeHigh };
}

function buildDatabase(options: {
  recordSize: number;
  fields: readonly SyntheticField[];
  records: readonly Uint8Array[];
  compressed?: Uint8Array;
  cancelledRecordCount?: number;
}): { database: Uint8Array; metadataXml: string } {
  const compressed = options.compressed ?? new Uint8Array();
  const paddedCompressedLength = compressed.length === 0 ? 0 : Math.ceil(compressed.length / 8) * 8;
  const tableLength = 36 + options.fields.length * 16 + options.records.length * options.recordSize + paddedCompressedLength + 4;
  const tableDataOffset = 36;
  const database = new Uint8Array(tableDataOffset + tableLength);
  const view = new DataView(database.buffer);
  database.set([0x44, 0x42, 0, 8, 0, 0, 0, 0], 0);
  view.setUint32(8, database.length, true);
  view.setUint32(16, 1, true);
  database.set(new TextEncoder().encode("Test"), 24);
  view.setUint32(28, 0, true);

  const tableOffset = tableDataOffset;
  view.setUint32(tableOffset, 2, true);
  view.setUint32(tableOffset + 4, options.recordSize, true);
  view.setUint32(tableOffset + 8, options.recordSize * 8 - 1, true);
  view.setUint32(tableOffset + 12, compressed.length, true);
  view.setUint16(tableOffset + 16, options.records.length, true);
  view.setUint16(tableOffset + 18, options.records.length, true);
  view.setUint16(tableOffset + 20, options.cancelledRecordCount ?? 0, true);
  view.setInt16(tableOffset + 22, -1, true);
  view.setUint8(tableOffset + 24, options.fields.length);

  let cursor = tableOffset + 36;
  for (const descriptor of options.fields) {
    view.setUint32(cursor, descriptor.storageType, true);
    view.setUint32(cursor + 4, descriptor.bitOffset, true);
    database.set(new TextEncoder().encode(descriptor.shortName), cursor + 8);
    view.setUint32(cursor + 12, descriptor.storageDepth, true);
    cursor += 16;
  }
  for (const record of options.records) {
    if (record.length !== options.recordSize) throw new Error("Synthetic record has the wrong size");
    database.set(record, cursor);
    cursor += record.length;
  }
  database.set(compressed, cursor);

  const fieldsXml = options.fields.map((descriptor) =>
    `<field name="${descriptor.name}" shortname="${descriptor.shortName}" type="${descriptor.xmlType}" depth="${String(descriptor.xmlDepth)}" null="False" rangehigh="${String(descriptor.rangeHigh)}" rangelow="${String(descriptor.rangeLow)}" />`,
  ).join("");
  const metadataXml = `<?xml version="1.0"?><database name="synthetic" shortname="synt" version="6"><table name="synthetic" shortname="Test"><fields>${fieldsXml}</fields></table></database>`;
  return { database, metadataXml };
}
