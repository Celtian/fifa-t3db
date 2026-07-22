export interface BinaryTableSection {
  readonly shortName: string;
  readonly offset: number;
  readonly endOffset: number;
  readonly recordsCrcOffset: number;
}

export interface BinaryDatabaseLayout {
  readonly tableDataOffset: number;
  readonly directoryCrcOffset: number;
  readonly tables: readonly BinaryTableSection[];
}

const CRC_POLYNOMIAL = 0x04c11db7;

// Expressed independently from src/writer.ts: each incoming bit is XORed with
// the current high CRC bit before the register is shifted.
export function referenceFifaCrc(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    for (let mask = 0x80; mask !== 0; mask >>>= 1) {
      const xorPolynomial = ((crc >>> 31) ^ ((byte & mask) === 0 ? 0 : 1)) !== 0;
      crc = (crc << 1) >>> 0;
      if (xorPolynomial) crc = (crc ^ CRC_POLYNOMIAL) >>> 0;
    }
  }
  return crc >>> 0;
}

export function inspectDatabaseLayout(bytes: Uint8Array): BinaryDatabaseLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint32(16, true);
  const directoryCrcOffset = 24 + tableCount * 8;
  const tableDataOffset = directoryCrcOffset + 4;
  const entries = Array.from({ length: tableCount }, (_, index) => {
    const entryOffset = 24 + index * 8;
    return {
      shortName: new TextDecoder().decode(bytes.subarray(entryOffset, entryOffset + 4)),
      offset: tableDataOffset + view.getUint32(entryOffset + 4, true),
    };
  });

  const tables = entries.map((entry, index): BinaryTableSection => {
    const endOffset = entries[index + 1]?.offset ?? bytes.byteLength;
    const recordSize = view.getUint32(entry.offset + 4, true);
    const compressedLength = view.getUint32(entry.offset + 12, true);
    const writtenRecordCount = view.getUint16(entry.offset + 18, true);
    const fieldCount = view.getUint8(entry.offset + 24);
    const recordsOffset = entry.offset + 36 + fieldCount * 16;
    const compressedOffset = recordsOffset + writtenRecordCount * recordSize;
    const paddedCompressedLength = compressedLength === 0 ? 0 : (compressedLength + 7) & ~7;
    return {
      ...entry,
      endOffset,
      recordsCrcOffset: compressedOffset + paddedCompressedLength,
    };
  });

  return { tableDataOffset, directoryCrcOffset, tables };
}

export function tableBytes(bytes: Uint8Array, shortName: string): Uint8Array {
  const table = inspectDatabaseLayout(bytes).tables.find((candidate) => candidate.shortName === shortName);
  if (table === undefined) throw new Error(`Unknown binary table ${shortName}`);
  return bytes.subarray(table.offset, table.endOffset);
}
