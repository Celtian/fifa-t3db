import { FifaDatabaseError } from "./error.js";

export class BinaryView {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly length: number;

  constructor(bytes: Uint8Array, length = bytes.byteLength) {
    if (!Number.isInteger(length) || length < 0 || length > bytes.byteLength) {
      throw new FifaDatabaseError(`Invalid binary view length ${String(length)}`);
    }

    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, length);
    this.length = length;
  }

  ensure(offset: number, size: number, context: string): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > this.length
    ) {
      throw new FifaDatabaseError(
        `${context}: byte range ${formatOffset(offset)}..${formatOffset(offset + size)} exceeds database length ${String(this.length)}`,
      );
    }
  }

  u8(offset: number, context: string): number {
    this.ensure(offset, 1, context);
    return this.view.getUint8(offset);
  }

  u16(offset: number, context: string): number {
    this.ensure(offset, 2, context);
    return this.view.getUint16(offset, true);
  }

  i16(offset: number, context: string): number {
    this.ensure(offset, 2, context);
    return this.view.getInt16(offset, true);
  }

  u32(offset: number, context: string): number {
    this.ensure(offset, 4, context);
    return this.view.getUint32(offset, true);
  }

  i32(offset: number, context: string): number {
    this.ensure(offset, 4, context);
    return this.view.getInt32(offset, true);
  }

  f32(offset: number, context: string): number {
    this.ensure(offset, 4, context);
    return this.view.getFloat32(offset, true);
  }

  slice(offset: number, size: number, context: string): Uint8Array {
    this.ensure(offset, size, context);
    return this.bytes.subarray(offset, offset + size);
  }
}

export function formatOffset(offset: number): string {
  return Number.isFinite(offset) && offset >= 0
    ? `0x${Math.trunc(offset).toString(16)}`
    : String(offset);
}
