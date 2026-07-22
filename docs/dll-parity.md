# FifaLibrary16.dll parity audit

This audit covers the FIFA 16 PC t3db read/write path. It is anchored to:

```text
FifaLibrary16.dll
SHA-256 711356a2cf7a87451940c84088bdfa0a7b512bc3651bf0b03a89179195cae957
```

The assembly is a 32-bit .NET Framework DLL. Its database routines were statically decompiled; the Linux test environment does not execute the Windows library. Tests therefore combine the decompiled behavior, fixed values from the supplied DLL-readable database, an independent structural parser, and an independent CRC implementation.

## Verified behavior

| DLL evidence | TypeScript behavior | Status |
| --- | --- | --- |
| `DbFile.LoadDb` reads `DB\0\x08`, platform byte, file length, table count, directory entries, and offsets relative to the byte after the directory CRC. | `database.ts` parses and bounds-checks the same PC layout. | Equivalent for platform `0` (PC). |
| `FieldDescriptor.EFieldTypes` assigns `String=0`, `Integer=3`, `Float=4`, `ShortCompressedString=13`, and `LongCompressedString=14`. | The same identifiers are accepted and checked against XML logical types. | Equivalent. |
| `DbReader.PopIntegerPc` consumes the low bits of each byte first and adds `RangeLow`; `DbWriter.PushIntegerPc` performs the inverse. | Packed integers use the descriptor bit offset/depth, least-significant-bit-first, with the XML range adjustment. | Equivalent. |
| `Record.Load` byte-aligns fixed strings, floats, and compressed pointers; the final record byte uses bit `0x80` as the invalid flag. | The reader uses the same alignment and skips invalid records. | Equivalent. |
| `Record.Save` zero-fills records and writes PC float32 values little-endian. | Rebuilt records are zero-filled and floats are written little-endian after float32 normalization. | Equivalent. |
| `HuffmannTree.Load` stores four bytes per node; `ReadString` consumes payload bits from bit 7 to bit 0. | Tree nodes and most-significant-bit-first payload decoding match. | Equivalent. |
| Short compressed strings have a one-byte decoded length. Long compressed strings write a byte-swapped two-byte length. Empty strings use pointer `-1`. | Types 13 and 14 use unsigned one-byte and big-endian two-byte lengths and pointer `-1` for empty values. | Equivalent over the supported length range. |
| `Table.Save` rounds the compressed block length up to eight before placing the records CRC. | Serialization applies the same block-relative padding and CRC placement. | Equivalent. |
| `FifaUtil.ComputeCrcDb11` starts at `0xffffffff`, processes bytes MSB-first with polynomial `0x04C11DB7`, and has no final XOR. `DbFile.ComputeAllCrc` covers the header, directory, each table header, and each descriptor/record/string region. | `writer.ts` uses the same algorithm and covered ranges. | Equivalent; original and regenerated fixture CRCs are independently tested. |

The supplied fixture confirms 137 tables, 109,169 valid rows, all stored CRCs, both packed and aligned fields, and Huffman-compressed strings. Modified output is independently checked for offsets, padding, counts, CRCs, preserved unchanged table bytes, and decoded row equality.

## Intentional differences

- The DLL normally reuses a table's existing Huffman tree and substitutes a space when a new byte has no code. The TypeScript writer rebuilds a deterministic tree from all modified-table strings, preserving previously unseen UTF-8 bytes. Its compressed bytes need not be identical, but decoded values are.
- The DLL keeps record capacity and writes clean trailing records. The editor intentionally compacts deletions and writes equal record/written counts with zero cancelled records.
- `Table.Load` records an unpadded compressed CRC position, while `Table.Save` writes the CRC after eight-byte padding. The TypeScript reader follows the saved on-disk layout, fixing the DLL load-side metadata bug for lengths not divisible by eight.
- The DLL truncates oversized fixed strings. The TypeScript editor rejects them, along with out-of-range numeric values, instead of silently losing data.
- The DLL reads the long compressed length through a signed `Int16`. The TypeScript implementation treats the on-disk prefix as unsigned and supports the full declared two-byte range.
- The DLL also supports Xbox byte order. This library deliberately accepts and writes only FIFA 16 PC databases.
- Composite-key inference and immutable editor identities are API-level safeguards; they do not change the t3db binary field or record encoding.

## Confidence boundary

Logical PC database parity is covered. Byte-identical output is not promised because Huffman construction and record-capacity policy intentionally differ. A future audit against another DLL build must update the hash anchor and repeat the static comparison before tests accept it.
