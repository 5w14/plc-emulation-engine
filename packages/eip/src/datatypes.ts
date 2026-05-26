/**
 * CIP Data Types
 */

/**
 * CIP elementary data type codes
 */
export enum CipDataType {
  BOOL = 0x00c1,
  SINT = 0x00c2,
  INT = 0x00c3,
  DINT = 0x00c4,
  LINT = 0x00c5,
  USINT = 0x00c6,
  UINT = 0x00c7,
  UDINT = 0x00c8,
  ULINT = 0x00c9,
  REAL = 0x00ca,
  LREAL = 0x00cb,
  STRING = 0x00d0,
  BYTE = 0x00d1,
  WORD = 0x00d2,
  DWORD = 0x00d3,
  LWORD = 0x00d4,
}

/**
 * Map of data type codes to human-readable names
 */
export const DATA_TYPE_NAMES: Record<number, string> = {
  [CipDataType.BOOL]: "BOOL",
  [CipDataType.SINT]: "SINT",
  [CipDataType.INT]: "INT",
  [CipDataType.DINT]: "DINT",
  [CipDataType.LINT]: "LINT",
  [CipDataType.USINT]: "USINT",
  [CipDataType.UINT]: "UINT",
  [CipDataType.UDINT]: "UDINT",
  [CipDataType.ULINT]: "ULINT",
  [CipDataType.REAL]: "REAL",
  [CipDataType.LREAL]: "LREAL",
  [CipDataType.STRING]: "STRING",
  [CipDataType.BYTE]: "BYTE",
  [CipDataType.WORD]: "WORD",
  [CipDataType.DWORD]: "DWORD",
  [CipDataType.LWORD]: "LWORD",
};

/**
 * Get the byte size of a fixed-size CIP data type
 */
export function getDataTypeSize(type: CipDataType): number {
  switch (type) {
    case CipDataType.BOOL:
    case CipDataType.SINT:
    case CipDataType.USINT:
    case CipDataType.BYTE:
      return 1;
    case CipDataType.INT:
    case CipDataType.UINT:
    case CipDataType.WORD:
      return 2;
    case CipDataType.DINT:
    case CipDataType.UDINT:
    case CipDataType.REAL:
    case CipDataType.DWORD:
      return 4;
    case CipDataType.LINT:
    case CipDataType.ULINT:
    case CipDataType.LREAL:
    case CipDataType.LWORD:
      return 8;
    case CipDataType.STRING:
      throw new Error("STRING is variable-length; use readDataType to determine size");
    default:
      throw new Error(`Unknown CIP data type: 0x${(type as number).toString(16)}`);
  }
}

/**
 * Read a CIP data type value from a buffer
 */
export function readDataType(
  buf: Uint8Array,
  offset: number,
  type: CipDataType,
): { value: number | bigint | string | boolean; bytesRead: number } {
  const view = new DataView(buf.buffer, buf.byteOffset);

  switch (type) {
    case CipDataType.BOOL:
      ensureBytes(buf, offset, 1);
      return { value: buf[offset]! !== 0, bytesRead: 1 };

    case CipDataType.SINT:
      ensureBytes(buf, offset, 1);
      return { value: view.getInt8(offset), bytesRead: 1 };

    case CipDataType.INT:
      ensureBytes(buf, offset, 2);
      return { value: view.getInt16(offset, true), bytesRead: 2 };

    case CipDataType.DINT:
      ensureBytes(buf, offset, 4);
      return { value: view.getInt32(offset, true), bytesRead: 4 };

    case CipDataType.LINT:
      ensureBytes(buf, offset, 8);
      return { value: view.getBigInt64(offset, true), bytesRead: 8 };

    case CipDataType.USINT:
    case CipDataType.BYTE:
      ensureBytes(buf, offset, 1);
      return { value: buf[offset]!, bytesRead: 1 };

    case CipDataType.UINT:
    case CipDataType.WORD:
      ensureBytes(buf, offset, 2);
      return { value: view.getUint16(offset, true), bytesRead: 2 };

    case CipDataType.UDINT:
    case CipDataType.DWORD:
      ensureBytes(buf, offset, 4);
      return { value: view.getUint32(offset, true), bytesRead: 4 };

    case CipDataType.ULINT:
    case CipDataType.LWORD:
      ensureBytes(buf, offset, 8);
      return { value: view.getBigUint64(offset, true), bytesRead: 8 };

    case CipDataType.REAL:
      ensureBytes(buf, offset, 4);
      return { value: view.getFloat32(offset, true), bytesRead: 4 };

    case CipDataType.LREAL:
      ensureBytes(buf, offset, 8);
      return { value: view.getFloat64(offset, true), bytesRead: 8 };

    case CipDataType.STRING:
      return readLogixString(buf, offset);

    default:
      throw new Error(`Unsupported CIP data type: 0x${(type as number).toString(16)}`);
  }
}

/**
 * Write a CIP data type value to a buffer
 */
export function writeDataType(
  buf: Uint8Array,
  offset: number,
  type: CipDataType,
  value: number | bigint | string | boolean,
): number {
  const view = new DataView(buf.buffer, buf.byteOffset);

  switch (type) {
    case CipDataType.BOOL:
      ensureBytes(buf, offset, 1);
      buf[offset] = value ? 0x01 : 0x00;
      return 1;

    case CipDataType.SINT:
      ensureBytes(buf, offset, 1);
      view.setInt8(offset, Number(value));
      return 1;

    case CipDataType.INT:
      ensureBytes(buf, offset, 2);
      view.setInt16(offset, Number(value), true);
      return 2;

    case CipDataType.DINT:
      ensureBytes(buf, offset, 4);
      view.setInt32(offset, Number(value), true);
      return 4;

    case CipDataType.LINT:
      ensureBytes(buf, offset, 8);
      view.setBigInt64(offset, BigInt(value), true);
      return 8;

    case CipDataType.USINT:
    case CipDataType.BYTE:
      ensureBytes(buf, offset, 1);
      buf[offset] = Number(value);
      return 1;

    case CipDataType.UINT:
    case CipDataType.WORD:
      ensureBytes(buf, offset, 2);
      view.setUint16(offset, Number(value), true);
      return 2;

    case CipDataType.UDINT:
    case CipDataType.DWORD:
      ensureBytes(buf, offset, 4);
      view.setUint32(offset, Number(value), true);
      return 4;

    case CipDataType.ULINT:
    case CipDataType.LWORD:
      ensureBytes(buf, offset, 8);
      view.setBigUint64(offset, BigInt(value), true);
      return 8;

    case CipDataType.REAL:
      ensureBytes(buf, offset, 4);
      view.setFloat32(offset, Number(value), true);
      return 4;

    case CipDataType.LREAL:
      ensureBytes(buf, offset, 8);
      view.setFloat64(offset, Number(value), true);
      return 8;

    case CipDataType.STRING:
      return writeLogixString(buf, offset, String(value));

    default:
      throw new Error(`Unsupported CIP data type: 0x${(type as number).toString(16)}`);
  }
}

/**
 * Read a Logix STRING value
 * Format: uint32 LE length + ASCII bytes
 */
function readLogixString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const view = new DataView(buf.buffer, buf.byteOffset);
  ensureBytes(buf, offset, 4);
  const len = view.getUint32(offset, true);
  ensureBytes(buf, offset, 4 + len);
  const str = new TextDecoder().decode(buf.slice(offset + 4, offset + 4 + len));
  return { value: str, bytesRead: 4 + len };
}

/**
 * Write a Logix STRING value
 */
function writeLogixString(buf: Uint8Array, offset: number, value: string): number {
  const strBytes = new TextEncoder().encode(value);
  const totalSize = 4 + strBytes.length;
  ensureBytes(buf, offset, totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setUint32(offset, strBytes.length, true);
  buf.set(strBytes, offset + 4);
  return totalSize;
}

/**
 * Ensure buffer has enough bytes available
 */
function ensureBytes(buf: Uint8Array, offset: number, count: number): void {
  if (offset + count > buf.length) {
    throw new RangeError(
      `Buffer too short: need ${count} bytes at offset ${offset}, buffer length is ${buf.length}`,
    );
  }
}

/**
 * Get data type code from PLC core type name
 */
export function plcTypeToCipDataType(typeName: string): CipDataType | undefined {
  const upper = typeName.toUpperCase();
  switch (upper) {
    case "BOOL":
      return CipDataType.BOOL;
    case "SINT":
      return CipDataType.SINT;
    case "INT":
      return CipDataType.INT;
    case "DINT":
      return CipDataType.DINT;
    case "LINT":
      return CipDataType.LINT;
    case "USINT":
      return CipDataType.USINT;
    case "UINT":
      return CipDataType.UINT;
    case "UDINT":
      return CipDataType.UDINT;
    case "ULINT":
      return CipDataType.ULINT;
    case "REAL":
      return CipDataType.REAL;
    case "LREAL":
      return CipDataType.LREAL;
    case "STRING":
      return CipDataType.STRING;
    case "BYTE":
      return CipDataType.BYTE;
    case "WORD":
      return CipDataType.WORD;
    case "DWORD":
      return CipDataType.DWORD;
    case "LWORD":
      return CipDataType.LWORD;
    default:
      return undefined;
  }
}

/**
 * Convert CIP data type to PLC core type name
 */
export function cipDataTypeToPlcType(typeCode: number): string | undefined {
  return DATA_TYPE_NAMES[typeCode];
}
