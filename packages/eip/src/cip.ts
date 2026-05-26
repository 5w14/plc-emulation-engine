/**
 * CIP (Common Industrial Protocol) Services
 */

/**
 * CIP Service Codes
 */
export enum CipServiceCode {
  // Generic CIP services
  GetAttributeAll = 0x01,
  SetAttributeAll = 0x02,
  GetAttributeList = 0x03,
  SetAttributeList = 0x04,
  Reset = 0x05,
  Start = 0x06,
  Stop = 0x07,
  MultipleServicePacket = 0x0a,
  GetAttributeSingle = 0x0e,
  SetAttributeSingle = 0x10,

  // Connection Manager services
  ForwardClose = 0x4e,
  UnconnectedSend = 0x52,
  ForwardOpen = 0x54,
  LargeForwardOpen = 0x5b,

  // Logix-specific tag services
  ReadTag = 0x4c,
  WriteTag = 0x4d,
  ReadTagFragmented = 0x52,
  WriteTagFragmented = 0x53,
  ReadModifyWriteTag = 0x4e,
  GetInstanceAttributeList = 0x55,
}

/**
 * Bit mask OR'd onto the service code in a CIP reply
 */
export const CIP_REPLY_BIT = 0x80;

/**
 * CIP status codes
 */
export enum CipStatus {
  Success = 0x00,
  ConnectionFailure = 0x01,
  ResourceUnavailable = 0x02,
  InvalidParameterValue = 0x03,
  PathSegmentError = 0x04,
  PathDestinationUnknown = 0x05,
  PartialTransfer = 0x06,
  ConnectionLost = 0x07,
  ServiceNotSupported = 0x08,
  InvalidAttributeValue = 0x09,
  AttributeListError = 0x0a,
  AlreadyInRequestedMode = 0x0b,
  ObjectStateConflict = 0x0c,
  ObjectAlreadyExists = 0x0d,
  AttributeNotSettable = 0x0e,
  PrivilegeViolation = 0x0f,
  DeviceStateConflict = 0x10,
  ReplyDataTooLarge = 0x11,
  FragmentationPrimitive = 0x12,
  InsufficientData = 0x13,
  AttributeNotSupported = 0x14,
  TooMuchData = 0x15,
  ObjectDoesNotExist = 0x16,
}

/**
 * CIP Request message
 */
export interface CipRequest {
  service: number;
  path: Uint8Array;
  data: Uint8Array;
}

/**
 * CIP Response message
 */
export interface CipResponse {
  service: number;
  status: number;
  extendedStatus: number[];
  data: Uint8Array;
}

/**
 * Encode a CIP request
 *
 * Format:
 * [service: uint8] [path_size: uint8] [path: N bytes] [data: M bytes]
 */
export function encodeCipRequest(request: CipRequest): Uint8Array {
  if (request.path.length % 2 !== 0) {
    throw new Error(`CIP EPATH must be word-aligned (even length), got ${request.path.length}`);
  }

  const pathSizeWords = request.path.length / 2;
  if (pathSizeWords > 255) {
    throw new Error(`CIP EPATH too long: ${pathSizeWords} words exceeds max 255`);
  }

  const buf = new Uint8Array(2 + request.path.length + request.data.length);
  let offset = 0;

  buf[offset++] = request.service;
  buf[offset++] = pathSizeWords;
  buf.set(request.path, offset);
  offset += request.path.length;
  buf.set(request.data, offset);

  return buf;
}

/**
 * Decode a CIP response
 *
 * Format:
 * [reply_service: uint8] [reserved: uint8] [status: uint8] [ext_status_size: uint8]
 * [ext_status: N * uint16] [data: remaining]
 */
export function decodeCipResponse(data: Uint8Array): CipResponse {
  if (data.length < 4) {
    throw new Error(`CIP response too short: expected at least 4 bytes, got ${data.length}`);
  }

  const view = new DataView(data.buffer, data.byteOffset);
  let offset = 0;

  const service = data[offset]!;
  offset++;
  offset++; // Reserved byte
  const status = data[offset]!;
  offset++;
  const extendedStatusSize = data[offset]!;
  offset++;

  const extendedStatus: number[] = [];
  for (let i = 0; i < extendedStatusSize; i++) {
    extendedStatus.push(view.getUint16(offset, true));
    offset += 2;
  }

  const responseData = data.slice(offset);

  return {
    service,
    status,
    extendedStatus,
    data: responseData,
  };
}

/**
 * Encode a CIP response for sending
 */
export function encodeCipResponse(response: CipResponse): Uint8Array {
  const extStatusBytes = response.extendedStatus.length * 2;
  const buf = new Uint8Array(4 + extStatusBytes + response.data.length);
  const view = new DataView(buf.buffer);
  let offset = 0;

  buf[offset++] = response.service;
  buf[offset++] = 0x00; // Reserved
  buf[offset++] = response.status;
  buf[offset++] = response.extendedStatus.length;

  for (const ext of response.extendedStatus) {
    view.setUint16(offset, ext, true);
    offset += 2;
  }

  buf.set(response.data, offset);

  return buf;
}

/**
 * Create a successful CIP response
 */
export function createSuccessResponse(
  requestService: number,
  data: Uint8Array = new Uint8Array(0),
): CipResponse {
  return {
    service: requestService | CIP_REPLY_BIT,
    status: CipStatus.Success,
    extendedStatus: [],
    data,
  };
}

/**
 * Create a CIP error response
 */
export function createErrorResponse(
  requestService: number,
  status: number,
  extendedStatus: number[] = [],
): CipResponse {
  return {
    service: requestService | CIP_REPLY_BIT,
    status,
    extendedStatus,
    data: new Uint8Array(0),
  };
}
