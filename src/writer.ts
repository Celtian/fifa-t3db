import { FifaDatabaseError, requireValue } from "./error.js";
import { ParsedFifaDatabase, type InternalTable } from "./database.js";
import { parseMetadataXml } from "./metadata.js";
import type {
  FifaCompositeKey,
  FifaDatabaseEditor,
  FifaFieldInfo,
  FifaKeyDefinition,
  FifaKeySource,
  FifaRow,
  FifaTableData,
  FifaTableInfo,
  FifaValue,
  OpenFifaDatabaseInput,
} from "./types.js";

const HEADER_SIZE = 24;
const DIRECTORY_ENTRY_SIZE = 8;
const TABLE_HEADER_SIZE = 36;
const MAX_ROWS = 0xffff;
const CRC_POLYNOMIAL = 0x04c11db7;
const utf8Encoder = new TextEncoder();

type MutableRow = Record<string, FifaValue>;

interface HuffmanBranch {
  readonly zero: HuffmanTree;
  readonly one: HuffmanTree;
  readonly frequency: number;
  readonly minimumSymbol: number;
  readonly serial: number;
}

interface HuffmanLeaf {
  readonly symbol: number;
  readonly frequency: number;
  readonly minimumSymbol: number;
  readonly serial: number;
}

type HuffmanTree = HuffmanBranch | HuffmanLeaf;

interface HuffmanEncoding {
  readonly tree: Uint8Array;
  readonly codes: ReadonlyMap<number, readonly number[]>;
}

interface CompressedBlock {
  readonly bytes: Uint8Array;
  readonly pointers: readonly ReadonlyMap<string, number>[];
}

export function openEditableFifaDatabase(input: OpenFifaDatabaseInput): FifaDatabaseEditor {
  if (!(input.database instanceof Uint8Array)) {
    throw new FifaDatabaseError("database must be a Uint8Array");
  }
  if (typeof input.metadataXml !== "string") {
    throw new FifaDatabaseError("metadataXml must be a string");
  }

  // Own the source bytes so editing and serialization can never mutate the caller's view.
  const source = Uint8Array.from(input.database);
  const schema = parseMetadataXml(input.metadataXml);
  return new EditableFifaDatabase(new ParsedFifaDatabase(source, schema));
}

class EditableFifaDatabase implements FifaDatabaseEditor {
  readonly header;
  readonly schema;

  readonly #base: ParsedFifaDatabase;
  readonly #editedRows = new Map<string, MutableRow[]>();
  readonly #keyDefinitions = new Map<string, FifaKeyDefinition>();
  readonly #views = new Map<string, FifaTableData>();

  constructor(base: ParsedFifaDatabase) {
    this.#base = base;
    this.header = base.header;
    this.schema = base.schema;
  }

  listTables(): readonly FifaTableInfo[] {
    return this.#base.tables.map((table) => this.#currentInfo(table));
  }

  readTable(nameOrShortName: string): FifaTableData {
    const table = this.#base.getInternalTable(nameOrShortName);
    const cached = this.#views.get(table.info.shortName);
    if (cached !== undefined) return cached;

    const sourceRows = this.#editedRows.get(table.info.shortName) ?? this.#base.readTable(table.info.shortName).rows;
    const rows = Object.freeze(sourceRows.map((row) => Object.freeze({ ...row })));
    const result = Object.freeze({ info: this.#currentInfo(table), rows });
    this.#views.set(table.info.shortName, result);
    return result;
  }

  getKeyDefinition(nameOrShortName: string): FifaKeyDefinition {
    const table = this.#base.getInternalTable(nameOrShortName);
    const existing = this.#keyDefinitions.get(table.info.shortName);
    if (existing !== undefined) return existing;

    const rows = this.#currentRows(table);
    const declared = table.info.fields.filter((field) => field.key).map((field) => field.name);
    let fields = declared;
    let source: FifaKeySource = "xml";

    if (!tuplesAreUnique(rows, fields)) {
      const uniqueIndices = this.schema.indices
        .filter((index) => index.tableShortName === table.info.shortName)
        .filter((index) => declared.every((field) => index.fields.includes(field)))
        .filter((index) => tuplesAreUnique(rows, index.fields))
        .sort((left, right) => left.fields.length - right.fields.length);
      const preferredIndex = uniqueIndices[0];

      if (preferredIndex !== undefined) {
        fields = [...preferredIndex.fields];
        source = "index";
      } else {
        source = "inferred";
        fields = [...declared];
        const selected = new Set(fields);
        let collisionCount = collidingPairs(rows, fields);

        while (collisionCount > 0 && selected.size < table.info.fields.length) {
          let bestField: string | undefined;
          let bestCollisionCount = collisionCount;
          for (const field of table.info.fields) {
            if (selected.has(field.name)) continue;
            const candidateCount = collidingPairs(rows, [...fields, field.name]);
            if (bestField === undefined || candidateCount < bestCollisionCount) {
              bestField = field.name;
              bestCollisionCount = candidateCount;
            }
          }
          const selectedField = requireValue(bestField, `key inference made no progress for table ${table.info.name}`);
          fields.push(selectedField);
          selected.add(selectedField);
          collisionCount = bestCollisionCount;
        }
      }
    }

    const definition = Object.freeze({
      fields: Object.freeze([...fields]),
      source,
      unique: tuplesAreUnique(rows, fields),
    });
    this.#keyDefinitions.set(table.info.shortName, definition);
    return definition;
  }

  updateRow(nameOrShortName: string, key: unknown, changes: unknown): FifaRow {
    const table = this.#base.getInternalTable(nameOrShortName);
    const definition = this.getKeyDefinition(table.info.shortName);
    const normalizedKey = normalizeKeyObject(table, definition, key);
    if (!isRecord(changes)) {
      throw editError(table, "row changes must be an object");
    }
    const rows = this.#mutableRows(table);
    const index = findUniqueRowIndex(table, definition, rows, normalizedKey);
    const fieldsByName = new Map(table.info.fields.map((field) => [field.name, field]));
    const normalized: MutableRow = {};

    for (const [fieldName, value] of Object.entries(changes)) {
      const field = fieldsByName.get(fieldName);
      if (field === undefined) throw editError(table, `unknown field ${JSON.stringify(fieldName)}`);
      if (definition.fields.includes(fieldName)) {
        throw editError(table, `key field ${fieldName} is immutable; delete and insert the row to change identity`);
      }
      normalized[fieldName] = normalizeValue(table, field, value);
    }

    const current = requireValue(rows[index], `missing row ${String(index)} in table ${table.info.name}`);
    const updated = { ...current, ...normalized };
    rows[index] = updated;
    this.#invalidate(table);
    return Object.freeze({ ...updated });
  }

  insertRow(nameOrShortName: string, row: unknown): FifaRow {
    const table = this.#base.getInternalTable(nameOrShortName);
    const definition = this.getKeyDefinition(table.info.shortName);
    const rows = this.#mutableRows(table);
    if (rows.length >= MAX_ROWS) throw editError(table, `cannot exceed ${String(MAX_ROWS)} rows`);

    const normalized = normalizeCompleteRow(table, row);
    const tuple = keyFromRow(normalized, definition.fields);
    const matches = countMatchingRows(rows, definition.fields, tuple);
    if (matches !== 0) {
      throw editError(table, `cannot insert duplicate key ${formatKey(tuple)}; it already matches ${String(matches)} row(s)`);
    }

    rows.push(normalized);
    this.#invalidate(table);
    return Object.freeze({ ...normalized });
  }

  deleteRow(nameOrShortName: string, key: unknown): FifaRow {
    const table = this.#base.getInternalTable(nameOrShortName);
    const definition = this.getKeyDefinition(table.info.shortName);
    const normalizedKey = normalizeKeyObject(table, definition, key);
    const rows = this.#mutableRows(table);
    const index = findUniqueRowIndex(table, definition, rows, normalizedKey);
    const removed = requireValue(rows[index], `missing row ${String(index)} in table ${table.info.name}`);
    rows.splice(index, 1);
    this.#invalidate(table);
    return Object.freeze({ ...removed });
  }

  serialize(): Uint8Array {
    if (this.#editedRows.size === 0) {
      return this.#base.binary.bytes.slice(0, this.header.declaredFileSize);
    }

    const parts = this.#base.tables.map((table) => {
      const edited = this.#editedRows.get(table.info.shortName);
      return edited === undefined
        ? this.#base.binary.slice(table.info.offset, table.endOffset - table.info.offset, `table ${table.info.name}`)
        : serializeTable(this.#base, table, edited);
    });
    const fileSize = this.header.tableDataOffset + parts.reduce((total, part) => total + part.byteLength, 0);
    /* v8 ignore next -- @preserve -- constructing the parts would exceed the JS Uint8Array limit first */
    if (fileSize > 0xffff_ffff) throw new FifaDatabaseError(`Serialized database is too large: ${String(fileSize)} bytes`);

    const output = new Uint8Array(fileSize);
    output.set(this.#base.binary.slice(0, this.header.tableDataOffset, "database header and directory"));
    const view = new DataView(output.buffer);
    view.setUint32(8, fileSize, true);

    let cursor = this.header.tableDataOffset;
    for (let index = 0; index < this.#base.tables.length; index += 1) {
      const part = requireValue(parts[index], `missing serialized table part ${String(index)}`);
      view.setUint32(HEADER_SIZE + index * DIRECTORY_ENTRY_SIZE + 4, cursor - this.header.tableDataOffset, true);
      output.set(part, cursor);
      cursor += part.byteLength;
    }

    view.setUint32(20, fifaCrc(output.subarray(0, 20)), true);
    const directoryCrcOffset = HEADER_SIZE + this.header.tableCount * DIRECTORY_ENTRY_SIZE;
    view.setUint32(directoryCrcOffset, fifaCrc(output.subarray(HEADER_SIZE, directoryCrcOffset)), true);
    return output;
  }

  #currentRows(table: InternalTable): readonly Readonly<Record<string, FifaValue>>[] {
    return this.#editedRows.get(table.info.shortName) ?? this.#base.readTable(table.info.shortName).rows;
  }

  #mutableRows(table: InternalTable): MutableRow[] {
    const existing = this.#editedRows.get(table.info.shortName);
    if (existing !== undefined) return existing;
    const rows = this.#base.readTable(table.info.shortName).rows.map((row) => ({ ...row }));
    this.#editedRows.set(table.info.shortName, rows);
    return rows;
  }

  #currentInfo(table: InternalTable): FifaTableInfo {
    const rows = this.#editedRows.get(table.info.shortName);
    if (rows === undefined) return table.info;
    return Object.freeze({
      ...table.info,
      recordCount: rows.length,
      writtenRecordCount: rows.length,
      cancelledRecordCount: 0,
      validRecordCount: rows.length,
    });
  }

  #invalidate(table: InternalTable): void {
    this.#views.delete(table.info.shortName);
  }
}

function serializeTable(base: ParsedFifaDatabase, table: InternalTable, rows: readonly MutableRow[]): Uint8Array {
  const prefixLength = table.recordsOffset - table.info.offset;
  const prefix = base.binary.slice(table.info.offset, prefixLength, `header for table ${table.info.name}`).slice();
  const compressed = buildCompressedBlock(table, rows);
  const records = encodeRecords(table, rows, compressed.pointers);
  const paddedCompressedLength = compressed.bytes.length === 0 ? 0 : roundUp(compressed.bytes.length, 8);
  const recordsCrcOffset = prefix.length + records.length + paddedCompressedLength;
  const output = new Uint8Array(recordsCrcOffset + 4);
  output.set(prefix);
  output.set(records, prefix.length);
  output.set(compressed.bytes, prefix.length + records.length);

  const view = new DataView(output.buffer);
  view.setUint32(12, compressed.bytes.length, true);
  view.setUint16(16, rows.length, true);
  view.setUint16(18, rows.length, true);
  view.setUint16(20, 0, true);
  view.setUint32(32, fifaCrc(output.subarray(0, 32)), true);
  view.setUint32(recordsCrcOffset, fifaCrc(output.subarray(TABLE_HEADER_SIZE, recordsCrcOffset)), true);
  return output;
}

function encodeRecords(
  table: InternalTable,
  rows: readonly MutableRow[],
  pointers: readonly ReadonlyMap<string, number>[],
): Uint8Array {
  const output = new Uint8Array(rows.length * table.info.recordSize);
  const view = new DataView(output.buffer);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = requireValue(rows[rowIndex], `missing row ${String(rowIndex)} while encoding ${table.info.name}`);
    const stringPointers = requireValue(
      pointers[rowIndex],
      `missing string pointers for row ${String(rowIndex)} in ${table.info.name}`,
    );
    const recordOffset = rowIndex * table.info.recordSize;

    for (const field of table.fieldsByBitOffset) {
      const value = normalizeValue(table, field, row[field.name]);
      switch (field.storageType) {
        case 0: {
          const bytes = utf8Encoder.encode(value as string);
          output.set(bytes, recordOffset + field.bitOffset / 8);
          break;
        }
        case 3:
          writePackedInteger(output, recordOffset, field, (value as number) - field.rangeLow);
          break;
        case 4:
          view.setFloat32(recordOffset + field.bitOffset / 8, value as number, true);
          break;
        case 13:
        case 14: {
          const pointer = requireValue(
            stringPointers.get(field.name),
            `missing compressed-string pointer for ${table.info.name}.${field.name}`,
          );
          view.setInt32(recordOffset + field.bitOffset / 8, pointer, true);
          break;
        }
      }
    }
  }
  return output;
}

function writePackedInteger(output: Uint8Array, recordOffset: number, field: FifaFieldInfo, value: number): void {
  for (let bit = 0; bit < field.storageDepth; bit += 1) {
    if (Math.floor(value / 2 ** bit) % 2 === 0) continue;
    const absoluteBit = field.bitOffset + bit;
    const byteOffset = recordOffset + Math.floor(absoluteBit / 8);
    output[byteOffset] = requireValue(output[byteOffset], `packed integer byte ${String(byteOffset)}`)
      | (1 << (absoluteBit % 8));
  }
}

function buildCompressedBlock(table: InternalTable, rows: readonly MutableRow[]): CompressedBlock {
  const fields = table.fieldsByBitOffset.filter((field) => field.storageType === 13 || field.storageType === 14);
  const pointers = rows.map(() => new Map<string, number>());
  if (fields.length === 0) return { bytes: new Uint8Array(), pointers };

  const encodedRows = rows.map((row) => new Map(fields.map((field) => [field.name, utf8Encoder.encode(row[field.name] as string)])));
  const frequencies = new Uint32Array(256);
  for (const encoded of encodedRows) {
    for (const bytes of encoded.values()) {
      for (const byte of bytes) {
        frequencies[byte] = requireValue(frequencies[byte], `frequency for byte ${String(byte)}`) + 1;
      }
    }
  }
  const huffman = buildHuffman(frequencies);
  const chunks: Uint8Array[] = [huffman.tree];
  let length = huffman.tree.length;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const encoded = requireValue(encodedRows[rowIndex], `encoded strings for row ${String(rowIndex)}`);
    const rowPointers = requireValue(pointers[rowIndex], `string pointers for row ${String(rowIndex)}`);
    for (const field of fields) {
      const bytes = requireValue(encoded.get(field.name), `encoded bytes for field ${field.name}`);
      if (bytes.length === 0) {
        rowPointers.set(field.name, -1);
        continue;
      }
      rowPointers.set(field.name, length);
      const prefix = field.storageType === 13
        ? Uint8Array.of(bytes.length)
        : Uint8Array.of(bytes.length >>> 8, bytes.length & 0xff);
      const payload = encodeHuffmanBytes(bytes, huffman.codes);
      chunks.push(prefix, payload);
      length += prefix.length + payload.length;
    }
  }

  const output = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return { bytes: output, pointers };
}

function buildHuffman(frequencies: Uint32Array): HuffmanEncoding {
  let serial = 0;
  const queue: HuffmanTree[] = [];
  for (let symbol = 0; symbol < frequencies.length; symbol += 1) {
    const frequency = requireValue(frequencies[symbol], `frequency for symbol ${String(symbol)}`);
    if (frequency > 0) queue.push({ symbol, frequency, minimumSymbol: symbol, serial: serial++ });
  }
  if (queue.length === 0) return { tree: new Uint8Array(), codes: new Map() };

  if (queue.length === 1) {
    const only = requireValue(queue[0], "single Huffman symbol");
    queue.push({ ...only, serial: serial++ });
  }
  while (queue.length > 1) {
    queue.sort(compareHuffmanTrees);
    const zero = requireValue(queue.shift(), "zero Huffman branch");
    const one = requireValue(queue.shift(), "one Huffman branch");
    queue.push({
      zero,
      one,
      frequency: zero.frequency + one.frequency,
      minimumSymbol: Math.min(zero.minimumSymbol, one.minimumSymbol),
      serial: serial++,
    });
  }

  const root = queue[0] as HuffmanBranch;
  const branches: HuffmanBranch[] = [];
  const indices = new Map<HuffmanBranch, number>();
  const visit = (tree: HuffmanTree): void => {
    if (isLeaf(tree)) return;
    indices.set(tree, branches.length);
    branches.push(tree);
    visit(tree.zero);
    visit(tree.one);
  };
  visit(root);
  const tree = new Uint8Array(branches.length * 4);
  for (let index = 0; index < branches.length; index += 1) {
    const branch = requireValue(branches[index], `Huffman branch ${String(index)}`);
    writeHuffmanChild(tree, index * 4, branch.zero, indices);
    writeHuffmanChild(tree, index * 4 + 2, branch.one, indices);
  }

  const codes = new Map<number, readonly number[]>();
  const assignCodes = (node: HuffmanTree, bits: readonly number[]): void => {
    if (isLeaf(node)) {
      if (!codes.has(node.symbol)) codes.set(node.symbol, bits);
      return;
    }
    assignCodes(node.zero, [...bits, 0]);
    assignCodes(node.one, [...bits, 1]);
  };
  assignCodes(root, []);
  return { tree, codes };
}

function compareHuffmanTrees(left: HuffmanTree, right: HuffmanTree): number {
  return left.frequency - right.frequency || left.minimumSymbol - right.minimumSymbol || left.serial - right.serial;
}

function writeHuffmanChild(
  output: Uint8Array,
  offset: number,
  child: HuffmanTree,
  indices: ReadonlyMap<HuffmanBranch, number>,
): void {
  if (isLeaf(child)) {
    output[offset] = 0;
    output[offset + 1] = child.symbol;
    return;
  }
  output[offset] = requireValue(indices.get(child), "Huffman child index");
  output[offset + 1] = 0;
}

function encodeHuffmanBytes(bytes: Uint8Array, codes: ReadonlyMap<number, readonly number[]>): Uint8Array {
  const bits: number[] = [];
  for (const byte of bytes) {
    bits.push(...requireValue(codes.get(byte), `Huffman code for byte ${String(byte)}`));
  }

  // The game writer terminates every non-empty payload with a byte, including an
  // all-padding byte when the final symbol ended exactly on a byte boundary.
  const output = new Uint8Array(Math.floor(bits.length / 8) + 1);
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === 1) {
      const byteIndex = Math.floor(index / 8);
      output[byteIndex] = requireValue(output[byteIndex], `Huffman output byte ${String(byteIndex)}`)
        | (1 << (7 - (index % 8)));
    }
  }
  return output;
}

function isLeaf(tree: HuffmanTree): tree is HuffmanLeaf {
  return "symbol" in tree;
}

function normalizeCompleteRow(table: InternalTable, row: unknown): MutableRow {
  if (!isRecord(row)) throw editError(table, "inserted row must be an object");
  const expected = new Set(table.info.fields.map((field) => field.name));
  const supplied = Object.keys(row);
  for (const fieldName of supplied) {
    if (!expected.has(fieldName)) throw editError(table, `unknown field ${JSON.stringify(fieldName)}`);
  }
  const missing = table.info.fields.filter((field) => !Object.hasOwn(row, field.name)).map((field) => field.name);
  if (missing.length > 0) throw editError(table, `inserted row is missing field(s): ${missing.join(", ")}`);

  const normalized: MutableRow = {};
  for (const field of table.info.fields) normalized[field.name] = normalizeValue(table, field, row[field.name]);
  return normalized;
}

function normalizeValue(table: InternalTable, field: FifaFieldInfo, value: unknown): FifaValue {
  const context = `table ${table.info.name}, field ${field.name}`;
  if (field.storageType === 0 || field.storageType === 13 || field.storageType === 14) {
    if (typeof value !== "string") throw new FifaDatabaseError(`${context}: expected a string`);
    if (field.storageType === 0 && value.includes("\0")) {
      throw new FifaDatabaseError(`${context}: fixed strings cannot contain NUL bytes`);
    }
    const byteLength = utf8Encoder.encode(value).length;
    const capacity = field.storageType === 0 ? field.storageDepth / 8 : field.depth / 8;
    if (byteLength > capacity) {
      throw new FifaDatabaseError(
        `${context}: UTF-8 value uses ${String(byteLength)} bytes but capacity is ${String(capacity)}`,
      );
    }
    const prefixLimit = field.storageType === 13 ? 0xff : field.storageType === 14 ? 0xffff : Number.POSITIVE_INFINITY;
    if (byteLength > prefixLimit) {
      throw new FifaDatabaseError(
        `${context}: UTF-8 value is too long for storage type ${String(field.storageType)}`,
      );
    }
    return value;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FifaDatabaseError(`${context}: expected a finite number`);
  }
  if (field.storageType === 4) {
    const rounded = Math.fround(value);
    if (!Number.isFinite(rounded)) throw new FifaDatabaseError(`${context}: value is outside float32 range`);
    return rounded;
  }
  if (!Number.isSafeInteger(value)) throw new FifaDatabaseError(`${context}: expected a safe integer`);
  if (value < field.rangeLow || value > field.rangeHigh) {
    throw new FifaDatabaseError(
      `${context}: value ${String(value)} is outside XML range ${String(field.rangeLow)}..${String(field.rangeHigh)}`,
    );
  }
  const encoded = value - field.rangeLow;
  if (encoded < 0 || encoded >= 2 ** field.storageDepth) {
    throw new FifaDatabaseError(
      `${context}: value ${String(value)} does not fit ${String(field.storageDepth)} packed bits`,
    );
  }
  return value;
}

function normalizeKeyObject(
  table: InternalTable,
  definition: FifaKeyDefinition,
  key: unknown,
): FifaCompositeKey {
  if (!isRecord(key)) throw editError(table, "composite key must be an object");
  const actual = Object.keys(key).sort();
  const expected = [...definition.fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw editError(table, `composite key must contain exactly: ${definition.fields.join(", ")}`);
  }
  const fields = new Map(table.info.fields.map((field) => [field.name, field]));
  const normalized: Record<string, FifaValue> = {};
  for (const name of definition.fields) {
    normalized[name] = normalizeValue(
      table,
      requireValue(fields.get(name), `key field ${name} in table ${table.info.name}`),
      key[name],
    );
  }
  return normalized;
}

function findUniqueRowIndex(
  table: InternalTable,
  definition: FifaKeyDefinition,
  rows: readonly MutableRow[],
  key: FifaCompositeKey,
): number {
  const matches: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row !== undefined && fieldsEqual(row, key, definition.fields)) matches.push(index);
  }
  if (matches.length === 0) throw editError(table, `key ${formatKey(key)} does not match any row`);
  if (matches.length > 1) {
    throw editError(
      table,
      `key ${formatKey(key)} is ambiguous and matches ${String(matches.length)} indistinguishable rows`,
    );
  }
  return requireValue(matches[0], "unique matching row index");
}

function tuplesAreUnique(rows: readonly Readonly<Record<string, FifaValue>>[], fields: readonly string[]): boolean {
  return collidingPairs(rows, fields) === 0;
}

function collidingPairs(rows: readonly Readonly<Record<string, FifaValue>>[], fields: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const tuple = encodeTuple(row, fields);
    counts.set(tuple, (counts.get(tuple) ?? 0) + 1);
  }
  let result = 0;
  for (const count of counts.values()) result += count * (count - 1) / 2;
  return result;
}

function encodeTuple(row: Readonly<Record<string, FifaValue>>, fields: readonly string[]): string {
  return JSON.stringify(fields.map((field) => {
    const value = row[field];
    return typeof value === "number" ? ["n", value] : ["s", value];
  }));
}

function keyFromRow(row: Readonly<Record<string, FifaValue>>, fields: readonly string[]): FifaCompositeKey {
  const result: Record<string, FifaValue> = {};
  for (const field of fields) {
    result[field] = requireValue(row[field], `key field ${field}`);
  }
  return result;
}

function countMatchingRows(
  rows: readonly Readonly<Record<string, FifaValue>>[],
  fields: readonly string[],
  key: FifaCompositeKey,
): number {
  let count = 0;
  for (const row of rows) if (fieldsEqual(row, key, fields)) count += 1;
  return count;
}

function fieldsEqual(
  row: Readonly<Record<string, FifaValue>>,
  key: Readonly<Record<string, FifaValue>>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => row[field] === key[field]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatKey(key: Readonly<Record<string, FifaValue>>): string {
  return JSON.stringify(key);
}

function editError(table: InternalTable, message: string): FifaDatabaseError {
  return new FifaDatabaseError(`Table ${table.info.name} (${table.info.shortName}): ${message}`);
}

export function fifaCrc(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000_0000) !== 0 ? ((crc << 1) ^ CRC_POLYNOMIAL) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
