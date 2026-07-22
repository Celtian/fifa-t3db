import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BinaryView, formatOffset } from "../src/binary.js";
import { FifaDatabaseError, requireValue } from "../src/error.js";
import { openEditableFifaDatabase, openFifaDatabase, parseMetadataXml } from "../src/index.js";

const databaseBytes = readFileSync(new URL("../example/fifa_ng_db.db", import.meta.url));
const metadataXml = readFileSync(new URL("../example/fifa_ng_db-meta.xml", import.meta.url), "utf8");
const parsed = openFifaDatabase({ database: databaseBytes, metadataXml });

describe("binary utility validation", () => {
  test("requires internal invariant values", () => {
    expect(requireValue("value", "test value")).toBe("value");
    expect(() => { requireValue(undefined, "missing test value"); }).toThrow(FifaDatabaseError);
  });

  test("rejects invalid view lengths and byte ranges", () => {
    expect(() => new BinaryView(new Uint8Array(1), 2)).toThrow(/view length/i);
    const binary = new BinaryView(new Uint8Array(4));
    expect(() => { binary.ensure(-1, 1, "negative offset"); }).toThrow(/exceeds database length/i);
    expect(() => { binary.ensure(0, Number.NaN, "invalid size"); }).toThrow(/exceeds database length/i);
    expect(formatOffset(-1)).toBe("-1");
  });
});

describe("metadata validation coverage", () => {
  test("rejects malformed documents and missing tables", () => {
    expect(() => parseMetadataXml("<")).toThrow(/invalid metadata XML/i);
    expect(() => parseMetadataXml('<database name="db" shortname="data" version="1"><noop /></database>'))
      .toThrow(/does not contain any tables/i);
    expect(() => parseMetadataXml("<database />")).toThrow(/metadata <database>/i);
  });

  test("rejects malformed table and field attributes", () => {
    expect(() => parseMetadataXml(metadataWithField('type="UNKNOWN"'))).toThrow(/unsupported XML field type/i);
    expect(() => parseMetadataXml(metadataWithField('type="DBOFIELDTYPE_INTEGER" depth="-1"')))
      .toThrow(/must not be negative/i);
    expect(() => parseMetadataXml(metadataWithField('type="DBOFIELDTYPE_INTEGER" depth="x"')))
      .toThrow(/safe integer/i);
    expect(() => parseMetadataXml(metadataWithField('type="DBOFIELDTYPE_INTEGER" depth="1"', "bad")))
      .toThrow(/exactly four bytes/i);
    expect(() => parseMetadataXml(metadataWithField('type="DBOFIELDTYPE_INTEGER" depth="1"', "valu", "")))
      .toThrow(/missing or empty/i);
  });

  test("rejects duplicate tables and fields", () => {
    const table = tableXml('<field name="value" shortname="valu" type="DBOFIELDTYPE_INTEGER" depth="1" />');
    expect(() => parseMetadataXml(databaseXml(`${table}${table}`))).toThrow(/duplicate table name/i);
    expect(() => parseMetadataXml(databaseXml(tableXml(
      '<field name="value" shortname="valu" type="DBOFIELDTYPE_INTEGER" depth="1" />'
      + '<field name="value" shortname="othr" type="DBOFIELDTYPE_INTEGER" depth="1" />',
    )))).toThrow(/duplicate field name/i);
    expect(() => parseMetadataXml(databaseXml(tableXml(
      '<field name="one" shortname="valu" type="DBOFIELDTYPE_INTEGER" depth="1" />'
      + '<field name="two" shortname="valu" type="DBOFIELDTYPE_INTEGER" depth="1" />',
    )))).toThrow(/duplicate field short name/i);
  });

  test("validates XML indices", () => {
    const table = tableXml('<field name="value" shortname="valu" type="DBOFIELDTYPE_INTEGER" depth="1" />');
    const index = (tableShortName: string, fields: string, shortName = "indx") =>
      `<indices><index shortname="${shortName}" tableshortname="${tableShortName}"><indexfields>${fields}</indexfields></index></indices>`;
    const indexField = '<indexfield shortname="valu" />';

    expect(() => parseMetadataXml(databaseXml(`${index("nope", indexField)}${table}`)))
      .toThrow(/unknown table/i);
    expect(() => parseMetadataXml(databaseXml(`${index("Test", '<indexfield shortname="nope" />')}${table}`)))
      .toThrow(/unknown field/i);
    expect(() => parseMetadataXml(databaseXml(`${index("Test", "<noop />")}${table}`)))
      .toThrow(/does not contain fields/i);
    expect(() => parseMetadataXml(databaseXml(`${index("Test", indexField + indexField)}${table}`)))
      .toThrow(/duplicate field in index/i);
    const duplicateIndex = `<index shortname="indx" tableshortname="Test"><indexfields>${indexField}</indexfields></index>`;
    expect(() => parseMetadataXml(databaseXml(`<indices>${duplicateIndex}${duplicateIndex}</indices>${table}`)))
      .toThrow(/duplicate index short name/i);
  });

  test("applies omitted defaults and non-boolean attribute fallbacks", () => {
    const schema = parseMetadataXml(metadataWithField('type="DBOFIELDTYPE_INTEGER" depth="1" null="1"'));
    expect(schema.tables[0]?.fields[0]).toMatchObject({
      rangeLow: 0,
      rangeHigh: 0,
      nullable: false,
      key: false,
      updatable: false,
    });
  });
});

describe("database structural validation coverage", () => {
  test("validates API inputs and editor lookups", () => {
    expect(() => openFifaDatabase({ database: "bad" as unknown as Uint8Array, metadataXml })).toThrow(/Uint8Array/);
    expect(() => openFifaDatabase({ database: databaseBytes, metadataXml: 1 as unknown as string })).toThrow(/string/);
    expect(() => openEditableFifaDatabase({ database: "bad" as unknown as Uint8Array, metadataXml })).toThrow(/Uint8Array/);
    expect(() => openEditableFifaDatabase({ database: databaseBytes, metadataXml: 1 as unknown as string })).toThrow(/string/);
    expect(() => openEditableFifaDatabase({ database: databaseBytes, metadataXml }).readTable("missing"))
      .toThrow(/unknown table/i);
  });

  test("rejects unsupported platform and signature padding", () => {
    expectCorruption((bytes) => { bytes[4] = 1; }, /platform/i);
    expectCorruption((bytes) => { bytes[7] = 1; }, /signature padding/i);
  });

  test("rejects directory/schema inconsistencies", () => {
    expectCorruption((_bytes, view) => { view.setUint32(16, 136, true); }, /metadata defines 137 tables/i);
    expectCorruption((_bytes, view) => { view.setUint32(28, 0xffff_ffff, true); }, /outside the table data/i);
    const firstRelativeOffset = dataView(databaseBytes).getUint32(28, true);
    expectCorruption((_bytes, view) => { view.setUint32(36, firstRelativeOffset, true); }, /does not follow offset/i);
    expectCorruption((bytes) => { bytes.set(bytes.subarray(24, 28), 32); }, /duplicate table directory/i);
    expectCorruption((bytes) => { bytes[24] = 1; }, /invalid short-name byte/i);
    expect(() => openFifaDatabase({
      database: databaseBytes,
      metadataXml: metadataXml.replace('table name="version" shortname="DbIl"', 'table name="version" shortname="xxxx"'),
    })).toThrow(/missing from metadata XML/i);
  });

  test("rejects inconsistent table header counts and sizes", () => {
    const tableOffset = parsed.readTable("version").info.offset;
    expectCorruption((_bytes, view) => { view.setUint8(tableOffset + 24, 5); }, /binary declares 5 fields/i);
    expectCorruption((_bytes, view) => { view.setUint16(tableOffset + 18, 2, true); }, /written record count/i);
    expectCorruption((_bytes, view) => { view.setUint16(tableOffset + 20, 2, true); }, /cancelled record count/i);
    expectCorruption((_bytes, view) => { view.setUint32(tableOffset + 4, 0, true); }, /zero-sized records/i);
    expectCorruption((_bytes, view) => { view.setUint32(tableOffset + 8, 10_000, true); }, /bit length exceeds/i);
    expectCorruption((_bytes, view) => { view.setUint32(tableOffset + 12, 0xffff_fff0, true); }, /records CRC overlaps/i);
  });

  test("rejects invalid and conflicting field descriptors", () => {
    const version = parsed.readTable("version").info;
    const integer = descriptorOffset("version", "artificialkey");
    const fixed = descriptorOffset("version", "schema");
    const float = descriptorOffset("formations", "midfielders");
    const compressed = descriptorOffset("playernames", "name");

    expectCorruption((bytes) => { bytes.set(bytes.subarray(integer + 8, integer + 12), integer + 16 + 8); }, /duplicate binary field/i);
    expectCorruption((_bytes, view) => { view.setUint32(integer, 0, true); }, /conflicts with XML type/i);
    expectCorruption((_bytes, view) => { view.setUint32(integer + 12, 0, true); }, /integer depth/i);
    expectCorruption((_bytes, view) => { view.setUint32(fixed + 4, 1, true); }, /fixed string is not byte-aligned/i);
    expectCorruption((_bytes, view) => { view.setUint32(float + 12, 31, true); }, /float must be byte-aligned/i);
    expectCorruption((_bytes, view) => { view.setUint32(compressed + 4, 1, true); }, /compressed-string pointer must be byte-aligned/i);
    expectCorruption((_bytes, view) => { view.setUint32(integer + 4, version.recordSize * 8, true); }, /field exceeds/i);
  });
});

function metadataWithField(attributes: string, shortName = "valu", name = "value"): string {
  return databaseXml(tableXml(`<field name="${name}" shortname="${shortName}" ${attributes} />`));
}

function tableXml(fields: string): string {
  return `<table name="synthetic" shortname="Test"><fields>${fields}</fields></table>`;
}

function databaseXml(content: string): string {
  return `<database name="db" shortname="data" version="1">${content}</database>`;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function expectCorruption(change: (bytes: Uint8Array, view: DataView) => void, pattern: RegExp): void {
  const bytes = Uint8Array.from(databaseBytes);
  change(bytes, dataView(bytes));
  expect(() => openFifaDatabase({ database: bytes, metadataXml })).toThrow(pattern);
}

function descriptorOffset(tableName: string, fieldName: string): number {
  const table = parsed.readTable(tableName).info;
  const shortName = table.fields.find((field) => field.name === fieldName)?.shortName;
  if (shortName === undefined) throw new Error(`Unknown field ${tableName}.${fieldName}`);
  for (let index = 0; index < table.fieldCount; index += 1) {
    const offset = table.offset + 36 + index * 16;
    const candidate = new TextDecoder().decode(databaseBytes.subarray(offset + 8, offset + 12));
    if (candidate === shortName) return offset;
  }
  throw new Error(`Missing descriptor ${tableName}.${fieldName}`);
}
