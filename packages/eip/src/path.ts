/**
 * EPATH Segment Encoding/Decoding
 *
 * An EPATH is a sequence of segments, each beginning with a segment type byte.
 * The high 3 bits (7-5) encode the segment type.
 */

// Segment type constants
const SEGMENT_TYPE_MASK = 0xe0;
const SEGMENT_TYPE_PORT = 0x00;
const SEGMENT_TYPE_LOGICAL = 0x20;
const SEGMENT_SYMBOLIC = 0x91;

// Logical segment sub-types (bits 4-2)
const LOGICAL_TYPE_CLASS = 0x00;
const LOGICAL_TYPE_INSTANCE = 0x04;
const LOGICAL_TYPE_MEMBER = 0x08;
const LOGICAL_TYPE_CONNECTION_POINT = 0x0c;
const LOGICAL_TYPE_ATTRIBUTE = 0x10;

// Logical segment format (bits 1-0)
const LOGICAL_FORMAT_8BIT = 0x00;
const LOGICAL_FORMAT_16BIT = 0x01;

// Port segment flags
const PORT_EXTENDED_LINK = 0x10;

/**
 * Path segment types
 */
export type PathSegment =
  | { type: "class"; classId: number }
  | { type: "instance"; instanceId: number }
  | { type: "attribute"; attributeId: number }
  | { type: "member"; memberId: number }
  | { type: "connectionPoint"; connectionPointId: number }
  | { type: "port"; port: number; link: number }
  | { type: "ethernetPort"; ipAddress: string }
  | { type: "symbolic"; name: string };

/**
 * Encode a logical segment
 */
function encodeLogicalSegment(logicalType: number, value: number): Uint8Array {
  if (value < 0 || value > 0xffff) {
    throw new Error(`Logical segment value out of range: ${value}`);
  }

  if (value <= 0xff) {
    // 8-bit format: [segment_byte, value]
    const segByte = SEGMENT_TYPE_LOGICAL | logicalType | LOGICAL_FORMAT_8BIT;
    return new Uint8Array([segByte, value]);
  } else {
    // 16-bit format: [segment_byte, 0x00(pad), value_lo, value_hi]
    const segByte = SEGMENT_TYPE_LOGICAL | logicalType | LOGICAL_FORMAT_16BIT;
    const buf = new Uint8Array(4);
    buf[0] = segByte;
    buf[1] = 0x00; // pad
    const view = new DataView(buf.buffer);
    view.setUint16(2, value, true);
    return buf;
  }
}

/**
 * Encode a symbolic (ANSI Extended Symbol) segment
 *
 * Format: [0x91] [length] [name_ascii] [pad if odd]
 */
export function encodeSymbolicSegment(name: string): Uint8Array {
  if (name.length === 0) {
    throw new Error("Symbolic segment name must not be empty");
  }
  if (name.length > 255) {
    throw new Error(`Symbolic segment name too long: ${name.length} chars (max 255)`);
  }

  const nameBytes = new TextEncoder().encode(name);
  const needsPad = nameBytes.length % 2 !== 0;
  const totalLen = 2 + nameBytes.length + (needsPad ? 1 : 0);

  const buf = new Uint8Array(totalLen);
  let offset = 0;

  buf[offset++] = SEGMENT_SYMBOLIC;
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;

  if (needsPad) {
    buf[offset] = 0x00;
  }

  return buf;
}

/**
 * Decode a symbolic segment from buffer
 * Returns { segment, bytesConsumed }
 */
function decodeSymbolicSegment(
  data: Uint8Array,
  offset: number,
): { segment: PathSegment; bytesConsumed: number } {
  let pos = offset;
  pos++; // Skip 0x91

  const nameLen = data[pos]!;
  pos++;
  const name = new TextDecoder().decode(data.slice(pos, pos + nameLen));
  pos += nameLen;

  // Skip pad if name length is odd
  if (nameLen % 2 !== 0) {
    pos++;
  }

  return {
    segment: { type: "symbolic", name },
    bytesConsumed: pos - offset,
  };
}

/**
 * Encode an array element segment (member segment)
 */
export function encodeArrayElementSegment(index: number): Uint8Array {
  return encodeLogicalSegment(LOGICAL_TYPE_MEMBER, index);
}

/**
 * Encode a logical path to class/instance/attribute
 */
export function encodeLogicalPath(
  classId: number,
  instanceId: number,
  attributeId?: number,
): Uint8Array {
  const parts: Uint8Array[] = [
    encodeLogicalSegment(LOGICAL_TYPE_CLASS, classId),
    encodeLogicalSegment(LOGICAL_TYPE_INSTANCE, instanceId),
  ];

  if (attributeId !== undefined) {
    parts.push(encodeLogicalSegment(LOGICAL_TYPE_ATTRIBUTE, attributeId));
  }

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Encode a tag path string into an EPATH
 *
 * Supports formats:
 * - "MyTag" - simple tag
 * - "MyTag[5]" - array element
 * - "MyTag[1,2,3]" - multi-dimensional array
 * - "Program:MainProgram.MyTag" - program-scoped tag
 * - "MyUDT.Member" - structure member
 */
export function encodeTagPath(tagPath: string): Uint8Array {
  const segments: Uint8Array[] = [];
  const parts = tagPath.split(".");

  for (const part of parts) {
    const bracketIdx = part.indexOf("[");

    if (bracketIdx >= 0) {
      // Has array index
      const name = part.substring(0, bracketIdx);
      if (name.length > 0) {
        segments.push(encodeSymbolicSegment(name));
      }

      const closeBracket = part.indexOf("]", bracketIdx);
      if (closeBracket < 0) {
        throw new Error(`Invalid tag path: missing closing bracket in "${part}"`);
      }

      const indexStr = part.substring(bracketIdx + 1, closeBracket);
      const indices = indexStr.split(",").map((s) => {
        const idx = parseInt(s.trim(), 10);
        if (isNaN(idx) || idx < 0) {
          throw new Error(`Invalid array index "${s.trim()}" in tag path "${tagPath}"`);
        }
        return idx;
      });

      for (const idx of indices) {
        segments.push(encodeArrayElementSegment(idx));
      }
    } else {
      // Pure symbolic segment
      segments.push(encodeSymbolicSegment(part));
    }
  }

  const totalLen = segments.reduce((sum, s) => sum + s.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const seg of segments) {
    result.set(seg, offset);
    offset += seg.length;
  }
  return result;
}

/**
 * Decode an EPATH buffer into segments
 */
export function decodePath(data: Uint8Array, offset = 0, length?: number): PathSegment[] {
  const end = offset + (length ?? data.length - offset);
  const segments: PathSegment[] = [];
  let pos = offset;

  while (pos < end) {
    const segByte = data[pos]!;
    const segType = segByte & SEGMENT_TYPE_MASK;

    if (segByte === SEGMENT_SYMBOLIC) {
      // Symbolic segment
      const result = decodeSymbolicSegment(data, pos);
      segments.push(result.segment);
      pos += result.bytesConsumed;
    } else if (segType === SEGMENT_TYPE_LOGICAL) {
      // Logical segment
      const logicalType = segByte & 0x1c;
      const format = segByte & 0x03;
      pos++;

      let id: number;
      if (format === LOGICAL_FORMAT_8BIT) {
        id = data[pos]!;
        pos++;
      } else if (format === LOGICAL_FORMAT_16BIT) {
        pos++; // Skip pad
        const view = new DataView(data.buffer, data.byteOffset);
        id = view.getUint16(pos, true);
        pos += 2;
      } else {
        throw new Error(`Unsupported logical segment format: 0x${format.toString(16)}`);
      }

      switch (logicalType) {
        case LOGICAL_TYPE_CLASS:
          segments.push({ type: "class", classId: id });
          break;
        case LOGICAL_TYPE_INSTANCE:
          segments.push({ type: "instance", instanceId: id });
          break;
        case LOGICAL_TYPE_ATTRIBUTE:
          segments.push({ type: "attribute", attributeId: id });
          break;
        case LOGICAL_TYPE_MEMBER:
          segments.push({ type: "member", memberId: id });
          break;
        case LOGICAL_TYPE_CONNECTION_POINT:
          segments.push({ type: "connectionPoint", connectionPointId: id });
          break;
        default:
          throw new Error(`Unknown logical segment type: 0x${logicalType.toString(16)}`);
      }
    } else if (segType === SEGMENT_TYPE_PORT) {
      // Port segment - simplified handling
      const isExtended = (segByte & PORT_EXTENDED_LINK) !== 0;
      pos++;

      if (isExtended) {
        const linkLen = data[pos]!;
        pos++;
        const ipAddress = new TextDecoder().decode(data.slice(pos, pos + linkLen));
        pos += linkLen;
        if (linkLen % 2 !== 0) pos++; // Skip pad
        segments.push({ type: "ethernetPort", ipAddress });
      } else {
        const link = data[pos]!;
        pos++;
        segments.push({ type: "port", port: segByte & 0x0f, link });
      }
    } else {
      throw new Error(`Unrecognized EPATH segment type: 0x${segByte.toString(16)}`);
    }
  }

  return segments;
}

/**
 * Extract tag name from EPATH segments
 */
export function segmentsToTagName(segments: PathSegment[]): string {
  const parts: string[] = [];

  for (const seg of segments) {
    switch (seg.type) {
      case "symbolic":
        parts.push(seg.name);
        break;
      case "member": {
        // Array index - add to previous part
        if (parts.length > 0) {
          const prev = parts[parts.length - 1]!;
          if (prev.includes("[")) {
            // Multi-dimensional array
            parts[parts.length - 1] = prev.replace("]", `,${seg.memberId}]`);
          } else {
            parts[parts.length - 1] = `${prev}[${seg.memberId}]`;
          }
        }
        break;
      }
    }
  }

  return parts.join(".");
}
