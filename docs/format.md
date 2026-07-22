# PC t3db format version 8 notes

These notes describe the read path verified against `FifaLibrary16.dll` and the fixture in `example/`.

All multibyte values are little-endian unless explicitly noted. Offsets in the table directory are relative to the byte immediately after the short-name CRC.

## Database header

| Offset | Size | Meaning |
| ---: | ---: | --- |
| `0x00` | 8 | Signature: `44 42 00 08 00 00 00 00` on PC |
| `0x08` | 4 | Declared file size |
| `0x0c` | 4 | Unknown |
| `0x10` | 4 | Table count |
| `0x14` | 4 | Header CRC |
| `0x18` | 8 × count | Four-byte table short name and relative `uint32` offset |
| after directory | 4 | Short-name directory CRC |

## Table

Each table starts with a 36-byte header followed by one 16-byte descriptor per field, the written records, an optional compressed-string block, and a records CRC.

The table header stores record size, meaningful bit count, compressed block length, record/written/cancelled counts, field count, and its stored CRC. A descriptor contains internal type, bit offset, four-byte field short name, and storage depth.

Fields are decoded in ascending bit-offset order. The last record byte reserves bit `0x80` as the invalid/cancelled flag.

## Field storage types

- `0`: fixed-width, null-padded UTF-8 bytes. Depth is in bits.
- `3`: unsigned packed integer. Bits are consumed least-significant-bit first across little-endian bytes, then the XML `rangelow` is added. Date fields use the same storage and remain numeric.
- `4`: aligned little-endian IEEE-754 float32.
- `13`: aligned 32-bit pointer into the compressed block; decoded byte length is an unsigned byte. The descriptor depth describes the string capacity, not the pointer width.
- `14`: the same pointer representation with a big-endian unsigned 16-bit decoded length; its descriptor depth likewise describes string capacity.

## Huffman strings

The smallest non-negative string pointer identifies the end of the table's Huffman tree. Every tree node occupies four bytes:

```text
child for bit 0, leaf for bit 0, child for bit 1, leaf for bit 1
```

A zero child denotes a leaf; otherwise the child byte is the next node index. Encoded data is read most-significant-bit first. Decoding starts at node zero, returns there after every emitted byte, and stops after the prefixed decoded length. A zero-node tree stores the bytes directly. Pointer `-1` represents an empty value.

The compressed block's stored length excludes padding. Its records CRC follows at the next eight-byte boundary measured relative to the start of that block.

## Editing and checksums

Changed tables are compacted to their valid rows, with equal record and written counts and zero cancelled rows. Fixed strings are zero-padded, packed integers retain the least-significant-bit-first layout, and compressed pointers are rewritten against a deterministic per-table Huffman tree. Unchanged table byte ranges are copied verbatim.

All four checksum locations use the same FIFA CRC calculation: polynomial `0x04C11DB7`, initial value `0xffffffff`, most-significant-bit-first processing, and no final XOR. The covered ranges are:

- database bytes `0..20` for the header CRC;
- directory entries, excluding its stored CRC, for the short-name/directory CRC;
- the first 32 bytes of a table for its header CRC;
- table bytes beginning at offset 36 through the records and padded compressed block for its records CRC.
