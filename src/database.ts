import { BinaryView, formatOffset } from "./binary.js";
import { FifaDatabaseError, requireValue } from "./error.js";
import { parseMetadataXml } from "./metadata.js";
import type {
  FifaDatabase,
  FifaDatabaseHeader,
  FifaDatabaseSchema,
  FifaFieldInfo,
  FifaRow,
  FifaStorageType,
  FifaTableData,
  FifaTableInfo,
  FifaTableSchema,
  FifaValue,
  OpenFifaDatabaseInput,
} from "./types.js";

const HEADER_SIZE = 24;
const DIRECTORY_ENTRY_SIZE = 8;
const TABLE_HEADER_SIZE = 36;
const FIELD_DESCRIPTOR_SIZE = 16;
const PC_PLATFORM = 0 as const;
const utf8Decoder = new TextDecoder("utf-8");

export interface InternalTable {
  readonly info: FifaTableInfo;
  readonly fieldsByBitOffset: readonly FifaFieldInfo[];
  readonly recordsOffset: number;
  readonly recordsCrcOffset: number;
  readonly endOffset: number;
}

interface StringReference {
  readonly field: FifaFieldInfo;
  readonly pointer: number;
  readonly values: (FifaValue | undefined)[];
}

interface HuffmanNode {
  readonly child0: number;
  readonly leaf0: number;
  readonly child1: number;
  readonly leaf1: number;
}

export function openFifaDatabase(input: OpenFifaDatabaseInput): FifaDatabase {
  if (!(input.database instanceof Uint8Array)) {
    throw new FifaDatabaseError("database must be a Uint8Array");
  }
  if (typeof input.metadataXml !== "string") {
    throw new FifaDatabaseError("metadataXml must be a string");
  }

  const schema = parseMetadataXml(input.metadataXml);
  return new ParsedFifaDatabase(input.database, schema);
}

export class ParsedFifaDatabase implements FifaDatabase {
  readonly header: FifaDatabaseHeader;
  readonly schema: FifaDatabaseSchema;

  readonly binary: BinaryView;
  readonly tables: readonly InternalTable[];
  readonly tablesByName = new Map<string, InternalTable>();
  readonly cache = new Map<string, FifaTableData>();

  constructor(bytes: Uint8Array, schema: FifaDatabaseSchema) {
    const source = new BinaryView(bytes);
    this.header = parseHeader(source);
    this.schema = schema;
    this.binary = new BinaryView(bytes, this.header.declaredFileSize);
    this.tables = parseTables(this.binary, this.header, schema);

    for (const table of this.tables) {
      this.tablesByName.set(table.info.name, table);
      this.tablesByName.set(table.info.shortName, table);
    }
  }

  listTables(): readonly FifaTableInfo[] {
    return this.tables.map((table) => table.info);
  }

  readTable(nameOrShortName: string): FifaTableData {
    const table = this.tablesByName.get(nameOrShortName);
    if (table === undefined) {
      throw new FifaDatabaseError(`Unknown table ${JSON.stringify(nameOrShortName)}`);
    }

    const cached = this.cache.get(table.info.shortName);
    if (cached !== undefined) return cached;

    const data: FifaTableData = {
      info: table.info,
      rows: decodeRows(this.binary, table),
    };
    this.cache.set(table.info.shortName, data);
    return data;
  }

  getInternalTable(nameOrShortName: string): InternalTable {
    const table = this.tablesByName.get(nameOrShortName);
    if (table === undefined) throw new FifaDatabaseError(`Unknown table ${JSON.stringify(nameOrShortName)}`);
    return table;
  }
}

function parseHeader(binary: BinaryView): FifaDatabaseHeader {
  binary.ensure(0, HEADER_SIZE, "database header");
  const signature = Array.from(binary.slice(0, 8, "database signature"));

  if (signature[0] !== 0x44 || signature[1] !== 0x42 || signature[2] !== 0 || signature[3] !== 8) {
    throw new FifaDatabaseError(
      `Unsupported database signature: expected DB\\0\\x08, got ${signature.map(hexByte).join(" ")}`,
    );
  }

  const platform = signature[4];
  if (platform !== PC_PLATFORM) {
    throw new FifaDatabaseError(`Unsupported database platform ${String(platform)}; only FIFA 16 PC is supported`);
  }
  if (signature[5] !== 0 || signature[6] !== 0 || signature[7] !== 0) {
    throw new FifaDatabaseError(`Malformed database signature padding: ${signature.map(hexByte).join(" ")}`);
  }

  const declaredFileSize = binary.u32(8, "declared database size");
  if (declaredFileSize < HEADER_SIZE || declaredFileSize > binary.length) {
    throw new FifaDatabaseError(
      `Declared database size ${String(declaredFileSize)} is incompatible with supplied length ${String(binary.length)}`,
    );
  }

  const tableCount = binary.u32(16, "table count");
  const directoryEnd = HEADER_SIZE + tableCount * DIRECTORY_ENTRY_SIZE;
  binary.ensure(HEADER_SIZE, tableCount * DIRECTORY_ENTRY_SIZE + 4, "table directory");

  return {
    signature,
    formatVersion: 8,
    platform: PC_PLATFORM,
    declaredFileSize,
    unknown: binary.u32(12, "database header unknown value"),
    tableCount,
    headerCrc: binary.u32(20, "database header CRC"),
    shortNamesCrc: binary.u32(directoryEnd, "table short-name CRC"),
    tableDataOffset: directoryEnd + 4,
  };
}

function parseTables(
  binary: BinaryView,
  header: FifaDatabaseHeader,
  schema: FifaDatabaseSchema,
): readonly InternalTable[] {
  if (schema.tables.length !== header.tableCount) {
    throw new FifaDatabaseError(
      `Metadata defines ${String(schema.tables.length)} tables but database header declares ${String(header.tableCount)}`,
    );
  }

  const schemasByShortName = new Map(schema.tables.map((table) => [table.shortName, table]));
  const seen = new Set<string>();
  const tables: InternalTable[] = [];
  const directory = Array.from({ length: header.tableCount }, (_, index) => {
    const directoryOffset = HEADER_SIZE + index * DIRECTORY_ENTRY_SIZE;
    return {
      shortName: decodeShortName(binary, directoryOffset, `table directory entry ${String(index)}`),
      relativeOffset: binary.u32(directoryOffset + 4, `offset for table directory entry ${String(index)}`),
    };
  });

  for (let index = 0; index < directory.length; index += 1) {
    const entry = requireValue(directory[index], `missing table directory entry ${String(index)}`);
    const { shortName, relativeOffset } = entry;
    const offset = header.tableDataOffset + relativeOffset;
    const nextEntry = directory[index + 1];
    const endOffset = nextEntry === undefined
      ? header.declaredFileSize
      : header.tableDataOffset + nextEntry.relativeOffset;
    const tableSchema = schemasByShortName.get(shortName);

    if (offset < header.tableDataOffset || offset >= header.declaredFileSize) {
      throw new FifaDatabaseError(`Table ${shortName} offset ${formatOffset(offset)} is outside the table data`);
    }
    if (endOffset <= offset || endOffset > header.declaredFileSize) {
      throw new FifaDatabaseError(
        `Table ${shortName} end ${formatOffset(endOffset)} does not follow offset ${formatOffset(offset)}`,
      );
    }

    if (tableSchema === undefined) {
      throw new FifaDatabaseError(`Table ${shortName} at ${formatOffset(offset)} is missing from metadata XML`);
    }
    if (seen.has(shortName)) {
      throw new FifaDatabaseError(`Duplicate table directory entry ${shortName}`);
    }
    seen.add(shortName);
    tables.push(parseTable(binary, tableSchema, offset, relativeOffset, endOffset));
  }

  return tables;
}

function parseTable(
  binary: BinaryView,
  schema: FifaTableSchema,
  offset: number,
  relativeOffset: number,
  endOffset: number,
): InternalTable {
  const context = `table ${schema.name} (${schema.shortName}) at ${formatOffset(offset)}`;
  binary.ensure(offset, TABLE_HEADER_SIZE, `${context} header`);

  const recordSize = binary.u32(offset + 4, `${context} record size`);
  const recordBitLength = binary.u32(offset + 8, `${context} record bit length`);
  const compressedStringLength = binary.u32(offset + 12, `${context} compressed-string length`);
  const recordCount = binary.u16(offset + 16, `${context} record count`);
  const writtenRecordCount = binary.u16(offset + 18, `${context} written record count`);
  const cancelledRecordCount = binary.u16(offset + 20, `${context} cancelled record count`);
  binary.i16(offset + 22, `${context} unknown 16-bit value`);
  const fieldCount = binary.u8(offset + 24, `${context} field count`);
  binary.i32(offset + 28, `${context} unknown 32-bit value`);
  const headerCrc = binary.u32(offset + 32, `${context} header CRC`);

  if (fieldCount !== schema.fields.length) {
    throw new FifaDatabaseError(
      `${context}: binary declares ${String(fieldCount)} fields but metadata defines ${String(schema.fields.length)}`,
    );
  }
  if (writtenRecordCount > recordCount) {
    throw new FifaDatabaseError(`${context}: written record count exceeds record capacity`);
  }
  if (cancelledRecordCount > writtenRecordCount) {
    throw new FifaDatabaseError(`${context}: cancelled record count exceeds written record count`);
  }
  if (writtenRecordCount > 0 && recordSize === 0) {
    throw new FifaDatabaseError(`${context}: non-empty table has zero-sized records`);
  }
  if (recordBitLength > recordSize * 8) {
    throw new FifaDatabaseError(`${context}: record bit length exceeds record size`);
  }

  const descriptorsOffset = offset + TABLE_HEADER_SIZE;
  binary.ensure(descriptorsOffset, fieldCount * FIELD_DESCRIPTOR_SIZE, `${context} field descriptors`);
  const schemaFieldsByShortName = new Map(
    schema.fields.map((field, schemaIndex) => [field.shortName, { field, schemaIndex }]),
  );
  const fields: FifaFieldInfo[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < fieldCount; index += 1) {
    const descriptorOffset = descriptorsOffset + index * FIELD_DESCRIPTOR_SIZE;
    const storageTypeValue = binary.u32(descriptorOffset, `${context} field ${String(index)} storage type`);
    const bitOffset = binary.u32(descriptorOffset + 4, `${context} field ${String(index)} bit offset`);
    const shortName = decodeShortName(binary, descriptorOffset + 8, `${context} field ${String(index)}`);
    const storageDepth = binary.u32(descriptorOffset + 12, `${context} field ${shortName} depth`);
    const match = schemaFieldsByShortName.get(shortName);

    if (match === undefined) {
      throw new FifaDatabaseError(
        `${context}: field ${shortName} at ${formatOffset(descriptorOffset)} is missing from metadata XML`,
      );
    }
    if (seen.has(shortName)) {
      throw new FifaDatabaseError(`${context}: duplicate binary field descriptor ${shortName}`);
    }
    seen.add(shortName);

    const storageType = validateStorageType(storageTypeValue, match.field.type, context, match.field.name, descriptorOffset);
    validateFieldBounds(storageType, bitOffset, storageDepth, recordSize, context, match.field.name, descriptorOffset);
    fields.push({
      ...match.field,
      storageType,
      bitOffset,
      storageDepth,
      schemaIndex: match.schemaIndex,
    });
  }

  const recordsOffset = descriptorsOffset + fieldCount * FIELD_DESCRIPTOR_SIZE;
  const recordsByteLength = writtenRecordCount * recordSize;
  const compressedBase = recordsOffset + recordsByteLength;
  const recordsCrcOffset = compressedBase + (compressedStringLength === 0 ? 0 : roundUp(compressedStringLength, 8));
  binary.ensure(recordsOffset, recordsByteLength, `${context} records`);
  if (recordsCrcOffset + 4 > endOffset) {
    throw new FifaDatabaseError(`${context}: records CRC overlaps the next table`);
  }
  const recordsCrc = binary.u32(recordsCrcOffset, `${context} records CRC`);

  const fieldsInSchemaOrder = [...fields].sort((left, right) => left.schemaIndex - right.schemaIndex);
  const info: FifaTableInfo = {
    name: schema.name,
    shortName: schema.shortName,
    offset,
    relativeOffset,
    recordSize,
    recordBitLength,
    compressedStringLength,
    recordCount,
    writtenRecordCount,
    cancelledRecordCount,
    validRecordCount: writtenRecordCount - cancelledRecordCount,
    fieldCount,
    headerCrc,
    recordsCrc,
    fields: fieldsInSchemaOrder,
  };

  return {
    info,
    fieldsByBitOffset: [...fields].sort((left, right) => left.bitOffset - right.bitOffset),
    recordsOffset,
    recordsCrcOffset,
    endOffset,
  };
}

function decodeRows(binary: BinaryView, table: InternalTable): readonly FifaRow[] {
  const decodedValues: (FifaValue | undefined)[][] = [];
  const references: StringReference[] = [];
  const { info } = table;

  for (let recordIndex = 0; recordIndex < info.writtenRecordCount; recordIndex += 1) {
    const recordOffset = table.recordsOffset + recordIndex * info.recordSize;
    const invalidFlag = binary.u8(
      recordOffset + info.recordSize - 1,
      `invalid flag for record ${String(recordIndex)} in table ${info.name}`,
    );
    if ((invalidFlag & 0x80) !== 0) continue;

    const values = Array<FifaValue | undefined>(info.fieldCount);
    for (const field of table.fieldsByBitOffset) {
      const context = `table ${info.name}, record ${String(recordIndex)}, field ${field.name} at ${formatOffset(recordOffset)}`;
      switch (field.storageType) {
        case 0:
          values[field.schemaIndex] = decodeFixedString(binary, recordOffset, field, context);
          break;
        case 3:
          values[field.schemaIndex] = decodeInteger(binary, recordOffset, field, context);
          break;
        case 4:
          values[field.schemaIndex] = binary.f32(recordOffset + field.bitOffset / 8, context);
          break;
        case 13:
        case 14: {
          const pointer = binary.i32(recordOffset + field.bitOffset / 8, context);
          values[field.schemaIndex] = "";
          references.push({ field, pointer, values });
          break;
        }
      }
    }

    decodedValues.push(values);
  }

  decodeCompressedStrings(binary, table, references);
  return decodedValues.map((values) => {
    const row: Record<string, FifaValue> = {};
    for (const field of info.fields) {
      row[field.name] = requireValue(
        values[field.schemaIndex],
        `missing decoded value for ${info.name}.${field.name}`,
      );
    }
    return row;
  });
}

function decodeFixedString(
  binary: BinaryView,
  recordOffset: number,
  field: FifaFieldInfo,
  context: string,
): string {
  const bytes = binary.slice(recordOffset + field.bitOffset / 8, field.storageDepth / 8, context);
  const nullIndex = bytes.indexOf(0);
  return utf8Decoder.decode(nullIndex === -1 ? bytes : bytes.subarray(0, nullIndex));
}

function decodeInteger(
  binary: BinaryView,
  recordOffset: number,
  field: FifaFieldInfo,
  context: string,
): number {
  const shift = field.bitOffset % 8;
  const firstByte = Math.floor(field.bitOffset / 8);
  const byteCount = Math.ceil((shift + field.storageDepth) / 8);
  const bytes = binary.slice(recordOffset + firstByte, byteCount, context);
  let packed = 0;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    packed = packed * 256 + requireValue(bytes[index], `missing packed byte ${String(index)}`);
  }
  const encoded = Math.floor(packed / 2 ** shift) % 2 ** field.storageDepth;
  return encoded + field.rangeLow;
}

function decodeCompressedStrings(
  binary: BinaryView,
  table: InternalTable,
  references: readonly StringReference[],
): void {
  if (references.length === 0) return;

  const { info } = table;
  const compressedBase = table.recordsOffset + info.writtenRecordCount * info.recordSize;
  const compressedEnd = compressedBase + info.compressedStringLength;
  binary.ensure(compressedBase, info.compressedStringLength, `compressed strings for table ${info.name}`);

  let firstStringOffset = Number.POSITIVE_INFINITY;
  for (const reference of references) {
    if (reference.pointer >= 0 && reference.pointer < firstStringOffset) {
      firstStringOffset = reference.pointer;
    }
  }
  if (!Number.isFinite(firstStringOffset)) return;
  if (firstStringOffset % 4 !== 0) {
    throw new FifaDatabaseError(
      `Table ${info.name}: first compressed-string offset ${String(firstStringOffset)} is not aligned to a Huffman node`,
    );
  }
  if (firstStringOffset > info.compressedStringLength) {
    throw new FifaDatabaseError(`Table ${info.name}: Huffman tree exceeds the compressed-string block`);
  }

  const nodeCount = firstStringOffset / 4;
  const nodes: HuffmanNode[] = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const offset = compressedBase + index * 4;
    nodes.push({
      child0: binary.u8(offset, `Huffman node ${String(index)} in table ${info.name}`),
      leaf0: binary.u8(offset + 1, `Huffman node ${String(index)} in table ${info.name}`),
      child1: binary.u8(offset + 2, `Huffman node ${String(index)} in table ${info.name}`),
      leaf1: binary.u8(offset + 3, `Huffman node ${String(index)} in table ${info.name}`),
    });
  }

  for (const reference of references) {
    if (reference.pointer === -1) {
      reference.values[reference.field.schemaIndex] = "";
      continue;
    }
    if (reference.pointer < firstStringOffset || reference.pointer >= info.compressedStringLength) {
      throw new FifaDatabaseError(
        `Table ${info.name}, field ${reference.field.name}: compressed-string pointer ${String(reference.pointer)} is outside the payload`,
      );
    }

    let cursor = compressedBase + reference.pointer;
    let outputLength: number;
    if (reference.field.storageType === 13) {
      outputLength = binary.u8(cursor, `compressed length for ${info.name}.${reference.field.name}`);
      cursor += 1;
    } else {
      binary.ensure(cursor, 2, `compressed length for ${info.name}.${reference.field.name}`);
      outputLength = binary.view.getUint16(cursor, false);
      cursor += 2;
    }

    const output = nodeCount === 0
      ? binary.slice(cursor, outputLength, `uncompressed string for ${info.name}.${reference.field.name}`)
      : decodeHuffman(binary, nodes, cursor, compressedEnd, outputLength, info.name, reference.field.name);
    reference.values[reference.field.schemaIndex] = utf8Decoder.decode(output);
  }
}

function decodeHuffman(
  binary: BinaryView,
  nodes: readonly HuffmanNode[],
  start: number,
  end: number,
  outputLength: number,
  tableName: string,
  fieldName: string,
): Uint8Array {
  const output = new Uint8Array(outputLength);
  if (outputLength === 0) return output;

  let cursor = start;
  let outputIndex = 0;
  let nodeIndex = 0;

  while (outputIndex < outputLength) {
    if (cursor >= end) {
      throw new FifaDatabaseError(`Table ${tableName}, field ${fieldName}: truncated Huffman bitstream`);
    }
    const byte = binary.u8(cursor, `Huffman data for ${tableName}.${fieldName}`);
    cursor += 1;

    for (let bitPosition = 7; bitPosition >= 0 && outputIndex < outputLength; bitPosition -= 1) {
      const node = requireValue(nodes[nodeIndex], `missing Huffman node ${String(nodeIndex)}`);

      const bit = (byte >> bitPosition) & 1;
      const child = bit === 0 ? node.child0 : node.child1;
      if (child === 0) {
        output[outputIndex] = bit === 0 ? node.leaf0 : node.leaf1;
        outputIndex += 1;
        nodeIndex = 0;
      } else {
        if (child >= nodes.length) {
          throw new FifaDatabaseError(
            `Table ${tableName}, field ${fieldName}: Huffman child ${String(child)} is outside ${String(nodes.length)} nodes`,
          );
        }
        nodeIndex = child;
      }
    }
  }

  return output;
}

function validateStorageType(
  value: number,
  xmlType: FifaFieldInfo["type"],
  tableContext: string,
  fieldName: string,
  offset: number,
): FifaStorageType {
  if (value !== 0 && value !== 3 && value !== 4 && value !== 13 && value !== 14) {
    throw new FifaDatabaseError(
      `${tableContext}, field ${fieldName} at ${formatOffset(offset)}: unsupported internal storage type ${String(value)}`,
    );
  }

  const compatible =
    (value === 0 && xmlType === "DBOFIELDTYPE_STRING") ||
    (value === 3 && (xmlType === "DBOFIELDTYPE_INTEGER" || xmlType === "DBOFIELDTYPE_DATE")) ||
    (value === 4 && xmlType === "DBOFIELDTYPE_REAL") ||
    ((value === 13 || value === 14) && xmlType === "DBOFIELDTYPE_STRING");
  if (!compatible) {
    throw new FifaDatabaseError(
      `${tableContext}, field ${fieldName} at ${formatOffset(offset)}: storage type ${String(value)} conflicts with XML type ${xmlType}`,
    );
  }
  return value;
}

function validateFieldBounds(
  storageType: FifaStorageType,
  bitOffset: number,
  storageDepth: number,
  recordSize: number,
  tableContext: string,
  fieldName: string,
  descriptorOffset: number,
): void {
  const context = `${tableContext}, field ${fieldName} at ${formatOffset(descriptorOffset)}`;
  if (storageType === 3 && (storageDepth < 1 || storageDepth > 32)) {
    throw new FifaDatabaseError(`${context}: integer depth ${String(storageDepth)} is outside 1..32`);
  }
  if (storageType === 0 && (bitOffset % 8 !== 0 || storageDepth % 8 !== 0)) {
    throw new FifaDatabaseError(`${context}: fixed string is not byte-aligned`);
  }
  if (storageType === 4 && (bitOffset % 8 !== 0 || storageDepth !== 32)) {
    throw new FifaDatabaseError(`${context}: float must be byte-aligned with depth 32`);
  }
  if ((storageType === 13 || storageType === 14) && (bitOffset % 8 !== 0 || storageDepth % 8 !== 0)) {
    throw new FifaDatabaseError(`${context}: compressed-string pointer must be byte-aligned`);
  }

  const physicalDepth = storageType === 13 || storageType === 14 ? 32 : storageDepth;
  if (bitOffset + physicalDepth > recordSize * 8) {
    throw new FifaDatabaseError(`${context}: field exceeds the ${String(recordSize)}-byte record`);
  }
}

function decodeShortName(binary: BinaryView, offset: number, context: string): string {
  const bytes = binary.slice(offset, 4, `${context} short name`);
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new FifaDatabaseError(`${context}: invalid short-name byte ${hexByte(byte)} at ${formatOffset(offset)}`);
    }
  }
  return String.fromCharCode(...bytes);
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
