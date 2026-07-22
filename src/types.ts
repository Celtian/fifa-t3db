export type FifaValue = number | string;

export type FifaRow = Readonly<Record<string, FifaValue>>;

export type FifaXmlFieldType =
  | "DBOFIELDTYPE_DATE"
  | "DBOFIELDTYPE_INTEGER"
  | "DBOFIELDTYPE_REAL"
  | "DBOFIELDTYPE_STRING";

export type FifaStorageType = 0 | 3 | 4 | 13 | 14;

export interface FifaFieldSchema {
  readonly name: string;
  readonly shortName: string;
  readonly type: FifaXmlFieldType;
  readonly depth: number;
  readonly rangeLow: number;
  readonly rangeHigh: number;
  readonly nullable: boolean;
  readonly key: boolean;
  readonly updatable: boolean;
}

export interface FifaTableSchema {
  readonly name: string;
  readonly shortName: string;
  readonly fields: readonly FifaFieldSchema[];
}

export interface FifaIndexSchema {
  readonly shortName: string;
  readonly tableShortName: string;
  readonly fields: readonly string[];
}

export interface FifaDatabaseSchema {
  readonly name: string;
  readonly shortName: string;
  readonly version: number;
  readonly tables: readonly FifaTableSchema[];
  readonly indices: readonly FifaIndexSchema[];
}

export interface FifaDatabaseHeader {
  readonly signature: readonly number[];
  readonly formatVersion: number;
  readonly platform: 0;
  readonly declaredFileSize: number;
  readonly unknown: number;
  readonly tableCount: number;
  readonly headerCrc: number;
  readonly shortNamesCrc: number;
  readonly tableDataOffset: number;
}

export interface FifaFieldInfo extends FifaFieldSchema {
  readonly storageType: FifaStorageType;
  readonly bitOffset: number;
  readonly storageDepth: number;
  readonly schemaIndex: number;
}

export interface FifaTableInfo {
  readonly name: string;
  readonly shortName: string;
  readonly offset: number;
  readonly relativeOffset: number;
  readonly recordSize: number;
  readonly recordBitLength: number;
  readonly compressedStringLength: number;
  readonly recordCount: number;
  readonly writtenRecordCount: number;
  readonly cancelledRecordCount: number;
  readonly validRecordCount: number;
  readonly fieldCount: number;
  readonly headerCrc: number;
  readonly recordsCrc: number;
  readonly fields: readonly FifaFieldInfo[];
}

export interface FifaTableData {
  readonly info: FifaTableInfo;
  readonly rows: readonly FifaRow[];
}

export interface FifaDatabase {
  readonly header: FifaDatabaseHeader;
  readonly schema: FifaDatabaseSchema;
  listTables(): readonly FifaTableInfo[];
  readTable(nameOrShortName: string): FifaTableData;
}

export type FifaCompositeKey = Readonly<Record<string, FifaValue>>;

export type FifaRowChanges = Readonly<Record<string, FifaValue>>;

export type FifaKeySource = "xml" | "index" | "inferred";

export interface FifaKeyDefinition {
  readonly fields: readonly string[];
  readonly source: FifaKeySource;
  readonly unique: boolean;
}

export interface FifaDatabaseEditor extends FifaDatabase {
  getKeyDefinition(tableNameOrShortName: string): FifaKeyDefinition;
  updateRow(tableNameOrShortName: string, key: FifaCompositeKey, changes: FifaRowChanges): FifaRow;
  insertRow(tableNameOrShortName: string, row: Readonly<Record<string, FifaValue>>): FifaRow;
  deleteRow(tableNameOrShortName: string, key: FifaCompositeKey): FifaRow;
  serialize(): Uint8Array;
}

export interface OpenFifaDatabaseInput {
  readonly database: Uint8Array;
  readonly metadataXml: string;
}
