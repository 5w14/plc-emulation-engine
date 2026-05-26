/**
 * Logix Tag Services
 *
 * Implements Read Tag (0x4C), Write Tag (0x4D), and fragmented variants
 */

import {
  CipServiceCode,
  type CipRequest,
  type CipResponse,
  createSuccessResponse,
  createErrorResponse,
  CipStatus,
} from "./cip.ts";
import {
  encodeTagPath,
  encodeSymbolicSegment,
  encodeArrayElementSegment,
  decodePath,
  segmentsToTagName,
  type PathSegment,
} from "./path.ts";
import {
  CipDataType,
  readDataType,
  writeDataType,
  plcTypeToCipDataType,
  cipDataTypeToPlcType,
} from "./datatypes.ts";

/**
 * Parse a tag path string with optional array indices
 * Handles: "MyTag", "MyTag[5]", "MyTag[1,2]", "Program:Main.MyTag"
 */
export function parseTagPath(tagPath: string): { name: string; indices: number[] } {
  const bracketIdx = tagPath.indexOf("[");

  if (bracketIdx < 0) {
    return { name: tagPath, indices: [] };
  }

  const name = tagPath.substring(0, bracketIdx);
  const closeBracket = tagPath.indexOf("]", bracketIdx);
  if (closeBracket < 0) {
    throw new Error(`Invalid tag path: missing closing bracket in "${tagPath}"`);
  }

  const indexStr = tagPath.substring(bracketIdx + 1, closeBracket);
  const indices = indexStr.split(",").map((s) => {
    const idx = parseInt(s.trim(), 10);
    if (isNaN(idx) || idx < 0) {
      throw new Error(`Invalid array index "${s.trim()}" in tag path "${tagPath}"`);
    }
    return idx;
  });

  return { name, indices };
}

/**
 * Build a Read Tag (0x4C) request
 *
 * Request format:
 * - Service: 0x4C
 * - Path: symbolic segment(s) for tag name
 * - Data: uint16 LE number of elements to read
 */
export function buildReadTagRequest(tagPath: string, elementCount = 1): CipRequest {
  const path = encodeTagPath(tagPath);
  const data = new Uint8Array(2);
  const view = new DataView(data.buffer);
  view.setUint16(0, elementCount, true);

  return {
    service: CipServiceCode.ReadTag,
    path,
    data,
  };
}

/**
 * Parse a Read Tag response
 *
 * Response format:
 * - uint16 LE: CIP data type code
 * - N bytes: tag data (depends on type and element count)
 */
export function parseReadTagResponse(response: CipResponse): {
  type: number;
  data: Uint8Array;
  values: unknown[];
} {
  if (response.status !== CipStatus.Success) {
    throw new Error(`ReadTag failed with status 0x${response.status.toString(16)}`);
  }

  if (response.data.length < 2) {
    throw new Error(
      `ReadTag response too short: expected at least 2 bytes, got ${response.data.length}`,
    );
  }

  const view = new DataView(response.data.buffer, response.data.byteOffset);
  const type = view.getUint16(0, true);
  const data = response.data.slice(2);

  // Parse values based on type
  const values: unknown[] = [];
  let offset = 0;

  while (offset < data.length) {
    try {
      const result = readDataType(data, offset, type as CipDataType);
      values.push(result.value);
      offset += result.bytesRead;
    } catch {
      break;
    }
  }

  return { type, data, values };
}

/**
 * Build a Read Tag response from a tag value
 */
export function buildReadTagResponse(type: CipDataType, values: unknown[]): Uint8Array {
  // Calculate total size needed
  let dataSize = 2; // type code
  for (const value of values) {
    if (type === CipDataType.STRING) {
      const str = String(value);
      dataSize += 4 + str.length; // uint32 length + chars
    } else {
      dataSize += getDataTypeSize(type);
    }
  }

  const buf = new Uint8Array(dataSize);
  const view = new DataView(buf.buffer);
  view.setUint16(0, type, true);

  let offset = 2;
  for (const value of values) {
    offset += writeDataType(buf, offset, type, value as number | bigint | string | boolean);
  }

  return buf;
}

/**
 * Build a Write Tag (0x4D) request
 *
 * Request format:
 * - Service: 0x4D
 * - Path: symbolic segment(s) for tag name
 * - Data: uint16 LE type + uint16 LE element count + value bytes
 */
export function buildWriteTagRequest(
  tagPath: string,
  type: CipDataType,
  values: unknown[],
): CipRequest {
  const path = encodeTagPath(tagPath);

  // Calculate value data size
  let valueSize = 0;
  for (const value of values) {
    if (type === CipDataType.STRING) {
      valueSize += 4 + String(value).length;
    } else {
      valueSize += getDataTypeSize(type);
    }
  }

  const data = new Uint8Array(4 + valueSize);
  const view = new DataView(data.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, values.length, true);

  let offset = 4;
  for (const value of values) {
    offset += writeDataType(data, offset, type, value as number | bigint | string | boolean);
  }

  return {
    service: CipServiceCode.WriteTag,
    path,
    data,
  };
}

/**
 * Parse a Write Tag request
 *
 * Returns the tag path, data type, and values to write
 */
export function parseWriteTagRequest(request: CipRequest): {
  tagPath: string;
  type: number;
  values: unknown[];
} {
  // Decode path to get tag name
  const segments = decodePath(request.path);
  const tagPath = segmentsToTagName(segments);

  // Parse request data
  const view = new DataView(request.data.buffer, request.data.byteOffset);
  const type = view.getUint16(0, true);
  const elementCount = view.getUint16(2, true);

  const values: unknown[] = [];
  let offset = 4;

  for (let i = 0; i < elementCount; i++) {
    const result = readDataType(request.data, offset, type as CipDataType);
    values.push(result.value);
    offset += result.bytesRead;
  }

  return { tagPath, type, values };
}

/**
 * Parse a Read Tag request
 */
export function parseReadTagRequest(request: CipRequest): {
  tagPath: string;
  elementCount: number;
} {
  const segments = decodePath(request.path);
  const tagPath = segmentsToTagName(segments);

  const view = new DataView(request.data.buffer, request.data.byteOffset);
  const elementCount = view.getUint16(0, true);

  return { tagPath, elementCount };
}

/**
 * Get the byte size of a data type
 */
function getDataTypeSize(type: CipDataType): number {
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
    default:
      throw new Error(
        `Cannot get size for variable-length type: 0x${(type as number).toString(16)}`,
      );
  }
}

export { CipDataType, CipStatus, CipServiceCode, plcTypeToCipDataType, cipDataTypeToPlcType };
