/**
 * EtherNet/IP Encapsulation Layer
 *
 * Every EtherNet/IP message starts with a 24-byte encapsulation header:
 * ```
 * Offset  Size  Field
 * 0       2     command (uint16 LE)
 * 2       2     length (uint16 LE)
 * 4       4     sessionHandle (uint32 LE)
 * 8       4     status (uint32 LE)
 * 12      8     senderContext (8 bytes, opaque)
 * 20      4     options (uint32 LE)
 * ```
 */

/** Size of the encapsulation header in bytes */
export const ENCAP_HEADER_SIZE = 24;

/** Size of the sender context field */
const SENDER_CONTEXT_SIZE = 8;

/**
 * Encapsulation command codes
 * Encapsulation command codes
 */
export enum EncapsulationCommand {
  /** NOP - No operation, used as keep-alive */
  NOP = 0x0000,
  /** ListServices - Query supported encapsulation services */
  ListServices = 0x0004,
  /** ListIdentity - Query device identity (UDP broadcast typical) */
  ListIdentity = 0x0063,
  /** ListInterfaces - Query available CIP transport interfaces */
  ListInterfaces = 0x0064,
  /** RegisterSession - Establish an encapsulation session */
  RegisterSession = 0x0065,
  /** UnregisterSession - Terminate an encapsulation session */
  UnregisterSession = 0x0066,
  /** SendRRData - Send Request/Reply Data (unconnected messaging) */
  SendRRData = 0x006f,
  /** SendUnitData - Send Unit Data (connected messaging) */
  SendUnitData = 0x0070,
}

/**
 * Encapsulation status codes
 * Encapsulation status codes
 */
export enum EncapsulationStatus {
  Success = 0x00000000,
  InvalidCommand = 0x00000001,
  InsufficientMemory = 0x00000002,
  IncorrectData = 0x00000003,
  InvalidSessionHandle = 0x00000064,
  InvalidLength = 0x00000065,
  UnsupportedProtocolRevision = 0x00000069,
}

/**
 * Encapsulation header fields
 */
export interface EncapsulationHeader {
  command: number;
  length: number;
  sessionHandle: number;
  status: number;
  senderContext: Uint8Array;
  options: number;
}

/**
 * Encode an encapsulation header into a 24-byte buffer
 */
export function encodeHeader(header: EncapsulationHeader): Uint8Array {
  const buf = new Uint8Array(ENCAP_HEADER_SIZE);
  const view = new DataView(buf.buffer);

  view.setUint16(0, header.command, true);
  view.setUint16(2, header.length, true);
  view.setUint32(4, header.sessionHandle, true);
  view.setUint32(8, header.status, true);

  if (header.senderContext.length !== SENDER_CONTEXT_SIZE) {
    throw new Error(
      `senderContext must be exactly ${SENDER_CONTEXT_SIZE} bytes, got ${header.senderContext.length}`,
    );
  }
  buf.set(header.senderContext, 12);

  view.setUint32(20, header.options, true);

  return buf;
}

/**
 * Decode a 24-byte encapsulation header
 */
export function decodeHeader(data: Uint8Array): EncapsulationHeader {
  if (data.length < ENCAP_HEADER_SIZE) {
    throw new Error(
      `Buffer too short for encapsulation header: need ${ENCAP_HEADER_SIZE} bytes, got ${data.length}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset);

  return {
    command: view.getUint16(0, true),
    length: view.getUint16(2, true),
    sessionHandle: view.getUint32(4, true),
    status: view.getUint32(8, true),
    senderContext: data.slice(12, 20),
    options: view.getUint32(20, true),
  };
}

/**
 * Build a complete encapsulation packet (header + payload)
 */
export function encodePacket(
  command: number,
  sessionHandle: number,
  senderContext?: Uint8Array | null,
  data?: Uint8Array | null,
): Uint8Array {
  const ctx = new Uint8Array(SENDER_CONTEXT_SIZE);
  if (senderContext) {
    ctx.set(senderContext.subarray(0, Math.min(senderContext.length, SENDER_CONTEXT_SIZE)));
  }

  const payload = data ?? new Uint8Array(0);

  const header = encodeHeader({
    command,
    length: payload.length,
    sessionHandle,
    status: 0,
    senderContext: ctx,
    options: 0,
  });

  if (payload.length === 0) {
    return header;
  }

  const result = new Uint8Array(header.length + payload.length);
  result.set(header);
  result.set(payload, header.length);
  return result;
}

/**
 * Parse a complete encapsulation packet into header and payload
 */
export function parsePacket(data: Uint8Array): {
  header: EncapsulationHeader;
  payload: Uint8Array;
} {
  const header = decodeHeader(data);
  const payload = data.slice(ENCAP_HEADER_SIZE, ENCAP_HEADER_SIZE + header.length);
  return { header, payload };
}
