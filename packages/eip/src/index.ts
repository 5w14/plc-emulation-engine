/**
 * @plc-emulation/eip
 *
 * EtherNet/IP CIP protocol implementation for PLC Emulation Engine
 *
 * This package provides:
 * - EtherNet/IP encapsulation layer (24-byte header, command codes)
 * - Common Packet Format (CPF) for SendRRData/SendUnitData
 * - CIP service handling (ReadTag 0x4C, WriteTag 0x4D)
 * - EPATH symbolic segment encoding/decoding
 * - CIP data type encoding/decoding
 * - TCP server accepting connections on port 44818
 *
 * Compatible with libplctag and other EtherNet/IP clients.
 *
 * @example
 * ```typescript
 * import { createPlcEngine } from '@plc-emulation/core';
 * import { startEipServer } from '@plc-emulation/eip';
 *
 * const engine = createPlcEngine();
 * const server = startEipServer({ engine, port: 44818 });
 *
 * // Client can now connect with:
 * // plc_tag_create("protocol=ab_eip&gateway=127.0.0.1&path=1,0&cpu=LGX&name=MyTag")
 * ```
 */

// Encapsulation layer
export {
  EncapsulationCommand,
  EncapsulationStatus,
  ENCAP_HEADER_SIZE,
  encodeHeader,
  decodeHeader,
  encodePacket,
  type EncapsulationHeader,
} from "./encapsulation.ts";

// Common Packet Format
export {
  CpfItemType,
  encodeCpf,
  decodeCpf,
  buildUnconnectedCpf,
  buildConnectedCpf,
  type CpfItem,
} from "./cpf.ts";

// CIP services
export {
  CipServiceCode,
  CipStatus,
  CIP_REPLY_BIT,
  encodeCipRequest,
  decodeCipResponse,
  encodeCipResponse,
  createSuccessResponse,
  createErrorResponse,
  type CipRequest,
  type CipResponse,
} from "./cip.ts";

// EPATH encoding/decoding
export {
  encodeSymbolicSegment,
  encodeArrayElementSegment,
  encodeLogicalPath,
  encodeTagPath,
  decodePath,
  segmentsToTagName,
  type PathSegment,
} from "./path.ts";

// Data types
export {
  CipDataType,
  DATA_TYPE_NAMES,
  getDataTypeSize,
  readDataType,
  writeDataType,
  plcTypeToCipDataType,
  cipDataTypeToPlcType,
} from "./datatypes.ts";

// Tag services
export {
  parseTagPath,
  buildReadTagRequest,
  parseReadTagRequest,
  buildReadTagResponse,
  buildWriteTagRequest,
  parseWriteTagRequest,
} from "./tag-services.ts";

// Identity object
export {
  createDefaultIdentity,
  encodeListIdentityResponse,
  VendorId,
  DeviceType,
  DeviceStatus,
  ExtendedDeviceStatus,
  DeviceState,
  type IdentityObject,
} from "./identity.ts";

// Server
export {
  startEipServer,
  type EipServerOptions,
  type EipServerHandle,
  type Socket,
} from "./server.ts";
