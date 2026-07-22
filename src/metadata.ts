import { XMLParser } from "fast-xml-parser";
import { FifaDatabaseError } from "./error.js";
import type {
  FifaDatabaseSchema,
  FifaFieldSchema,
  FifaIndexSchema,
  FifaTableSchema,
  FifaXmlFieldType,
} from "./types.js";

const FIELD_TYPES = new Set<FifaXmlFieldType>([
  "DBOFIELDTYPE_DATE",
  "DBOFIELDTYPE_INTEGER",
  "DBOFIELDTYPE_REAL",
  "DBOFIELDTYPE_STRING",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: true,
});

export function parseMetadataXml(metadataXml: string): FifaDatabaseSchema {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(metadataXml) as unknown;
  } catch (error) {
    throw new FifaDatabaseError(`Invalid metadata XML: ${errorMessage(error)}`);
  }

  const document = objectValue(parsed, "metadata document");
  const database = objectValue(document.database, "metadata <database>");
  const tables = arrayValue(database.table).map((value, index) =>
    parseTable(objectValue(value, `metadata table ${String(index)}`), index),
  );

  if (tables.length === 0) {
    throw new FifaDatabaseError("Metadata XML does not contain any tables");
  }

  assertUnique(tables, (table) => table.name, "table name");
  assertUnique(tables, (table) => table.shortName, "table short name");
  const indices = parseIndices(database.indices, tables);

  return {
    name: stringValue(database.name, "database name"),
    shortName: stringValue(database.shortname, "database short name"),
    version: integerValue(database.version, "database version"),
    tables,
    indices,
  };
}

function parseIndices(value: unknown, tables: readonly FifaTableSchema[]): readonly FifaIndexSchema[] {
  if (value === undefined) return [];
  const container = objectValue(value, "metadata <indices>");
  const tablesByShortName = new Map(tables.map((table) => [table.shortName, table]));

  const indices = arrayValue(container.index).map((entry, index) => {
    const item = objectValue(entry, `metadata index ${String(index)}`);
    const shortName = shortNameValue(item.shortname, `index ${String(index)} short name`);
    const tableShortName = shortNameValue(item.tableshortname, `index ${shortName} table short name`);
    const table = tablesByShortName.get(tableShortName);
    if (table === undefined) {
      throw new FifaDatabaseError(`Index ${shortName} references unknown table ${tableShortName}`);
    }

    const indexFields = objectValue(item.indexfields, `index ${shortName} <indexfields>`);
    const tableFields = new Map(table.fields.map((field) => [field.shortName, field.name]));
    const fields = arrayValue(indexFields.indexfield).map((fieldEntry, fieldIndex) => {
      const field = objectValue(fieldEntry, `field ${String(fieldIndex)} in index ${shortName}`);
      const fieldShortName = shortNameValue(field.shortname, `field ${String(fieldIndex)} in index ${shortName}`);
      const fieldName = tableFields.get(fieldShortName);
      if (fieldName === undefined) {
        throw new FifaDatabaseError(
          `Index ${shortName} references unknown field ${fieldShortName} in table ${table.name}`,
        );
      }
      return fieldName;
    });

    if (fields.length === 0) throw new FifaDatabaseError(`Index ${shortName} does not contain fields`);
    assertUnique(fields, (field) => field, `field in index ${shortName}`);
    return { shortName, tableShortName, fields };
  });
  assertUnique(indices, (index) => index.shortName, "index short name");
  return indices;
}

function parseTable(table: Record<string, unknown>, tableIndex: number): FifaTableSchema {
  const name = stringValue(table.name, `table ${String(tableIndex)} name`);
  const shortName = shortNameValue(table.shortname, `table ${name} short name`);
  const fieldsContainer = objectValue(table.fields, `table ${name} <fields>`);
  const fields = arrayValue(fieldsContainer.field).map((value, index) =>
    parseField(objectValue(value, `field ${String(index)} in table ${name}`), name, index),
  );

  assertUnique(fields, (field) => field.name, `field name in table ${name}`);
  assertUnique(fields, (field) => field.shortName, `field short name in table ${name}`);

  return { name, shortName, fields };
}

function parseField(
  field: Record<string, unknown>,
  tableName: string,
  fieldIndex: number,
): FifaFieldSchema {
  const context = `field ${String(fieldIndex)} in table ${tableName}`;
  const typeValue = stringValue(field.type, `${context} type`);
  if (!FIELD_TYPES.has(typeValue as FifaXmlFieldType)) {
    throw new FifaDatabaseError(`${context}: unsupported XML field type ${typeValue}`);
  }

  return {
    name: stringValue(field.name, `${context} name`),
    shortName: shortNameValue(field.shortname, `${context} short name`),
    type: typeValue as FifaXmlFieldType,
    depth: nonNegativeInteger(field.depth, `${context} depth`),
    rangeLow: integerValue(field.rangelow ?? "0", `${context} range low`),
    rangeHigh: integerValue(field.rangehigh ?? "0", `${context} range high`),
    nullable: booleanValue(field.null, false),
    key: booleanValue(field.key, false),
    updatable: booleanValue(field.update, false),
  };
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FifaDatabaseError(`${context} is missing or is not an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FifaDatabaseError(`${context} is missing or empty`);
  }
  return value;
}

function shortNameValue(value: unknown, context: string): string {
  const result = stringValue(value, context);
  if (new TextEncoder().encode(result).byteLength !== 4) {
    throw new FifaDatabaseError(`${context} must encode to exactly four bytes, got ${JSON.stringify(result)}`);
  }
  return result;
}

function integerValue(value: unknown, context: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new FifaDatabaseError(`${context} must be a safe integer, got ${String(value)}`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, context: string): number {
  const result = integerValue(value, context);
  if (result < 0) throw new FifaDatabaseError(`${context} must not be negative`);
  return result;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  return value.toLowerCase() === "true";
}

function assertUnique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  const values = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (values.has(value)) throw new FifaDatabaseError(`Duplicate ${label}: ${value}`);
    values.add(value);
  }
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- @preserve -- fast-xml-parser always throws Error instances */
  return error instanceof Error ? error.message : String(error);
}
