/**
 * CIP Identity Object
 *
 * Provides device identification information for ListIdentity responses.
 */

/**
 * Identity object attribute values
 */
export interface IdentityObject {
  /** Vendor ID (e.g., 0x0001 for Rockwell Automation) */
  vendorId: number;
  /** Device type code */
  deviceType: number;
  /** Product code */
  productCode: number;
  /** Major revision */
  revisionMajor: number;
  /** Minor revision */
  revisionMinor: number;
  /** Device status word */
  status: number;
  /** Serial number (unique per device) */
  serialNumber: number;
  /** Product name string */
  productName: string;
  /** Device state */
  state: number;
}

/**
 * Well-known vendor IDs
 */
export enum VendorId {
  RockwellAutomation = 0x0001,
  /**
   * PLC Emulation Project - registered vendor ID
   * Using a value in the experimental/private range (0xFFFF is reserved for prototyping)
   */
  PlcEmulation = 0xffff,
}

/**
 * Well-known device types
 */
export enum DeviceType {
  GenericDevice = 0x0000,
  ProgrammableLogicController = 0x000e,
  CommunicationsAdapter = 0x000c,
}

/**
 * Device status bits
 */
export enum DeviceStatus {
  Owned = 0x0001,
  Reserved = 0x0002,
  Configured = 0x0004,
  ExtendedDeviceStatusPresent = 0x0010,
  MinorRecoverableFault = 0x0100,
  MinorUnrecoverableFault = 0x0200,
  MajorRecoverableFault = 0x0400,
  MajorUnrecoverableFault = 0x0800,
}

/**
 * Extended device status
 */
export enum ExtendedDeviceStatus {
  SelfTestingOrUnknown = 0x0000,
  FirmwareUpdateInProgress = 0x0010,
  AtLeastOneFaultedIoConnection = 0x0020,
  NoIoConnectionsEstablished = 0x0030,
  NonVolatileConfigurationBad = 0x0040,
  MajorFault = 0x0050,
  AtLeastOneIoConnectionInRunMode = 0x0060,
  AtLeastOneIoConnectionEstablishedAllInIdleMode = 0x0070,
  Running = 0x0080,
}

/**
 * Device state
 */
export enum DeviceState {
  NonExistent = 0x00,
  DeviceSelfTesting = 0x01,
  Standby = 0x02,
  Operational = 0x03,
  MajorRecoverableFault = 0x04,
  MajorUnrecoverableFault = 0x05,
  Default = 0xff,
}

/**
 * Create a default identity for the PLC emulator
 */
export function createDefaultIdentity(options?: {
  vendorId?: number;
  productName?: string;
  serialNumber?: number;
}): IdentityObject {
  return {
    vendorId: options?.vendorId ?? VendorId.PlcEmulation,
    deviceType: DeviceType.ProgrammableLogicController,
    productCode: 0x0001,
    revisionMajor: 1,
    revisionMinor: 0,
    status: ExtendedDeviceStatus.Running,
    serialNumber: options?.serialNumber ?? generateSerialNumber(),
    productName: options?.productName ?? "PLC Emulation Engine",
    state: DeviceState.Operational,
  };
}

/**
 * Encode identity object for ListIdentity response
 *
 * Format includes socket address info + identity CPF item
 */
export function encodeListIdentityResponse(
  identity: IdentityObject,
  socketInfo: { ipAddress: string; port: number },
): Uint8Array {
  // Encode the identity CPF item data
  const productNameBytes = new TextEncoder().encode(identity.productName);
  const identityDataLen = 34 + productNameBytes.length;

  const identityData = new Uint8Array(identityDataLen);
  const view = new DataView(identityData.buffer);
  let offset = 0;

  // Protocol version (uint16) - must be 1
  view.setUint16(offset, 1, true);
  offset += 2;

  // Socket address (sockaddr struct, 16 bytes)
  // sin_family (uint16) - AF_INET = 2
  view.setUint16(offset, 2, false); // Big-endian for sockaddr
  offset += 2;
  // sin_port (uint16) - big-endian
  view.setUint16(offset, socketInfo.port, false);
  offset += 2;
  // sin_addr (uint32) - big-endian
  const ipParts = socketInfo.ipAddress.split(".").map(Number);
  const ipNum = (ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!;
  view.setUint32(offset, ipNum >>> 0, false);
  offset += 4;
  // sin_zero (8 bytes padding)
  offset += 8;

  // Vendor ID (uint16)
  view.setUint16(offset, identity.vendorId, true);
  offset += 2;

  // Device type (uint16)
  view.setUint16(offset, identity.deviceType, true);
  offset += 2;

  // Product code (uint16)
  view.setUint16(offset, identity.productCode, true);
  offset += 2;

  // Revision (uint8 major, uint8 minor)
  identityData[offset++] = identity.revisionMajor;
  identityData[offset++] = identity.revisionMinor;

  // Status (uint16)
  view.setUint16(offset, identity.status, true);
  offset += 2;

  // Serial number (uint32)
  view.setUint32(offset, identity.serialNumber, true);
  offset += 4;

  // Product name length (uint8)
  identityData[offset++] = productNameBytes.length;

  // Product name (ASCII)
  identityData.set(productNameBytes, offset);
  offset += productNameBytes.length;

  // State (uint8)
  identityData[offset++] = identity.state;

  return identityData;
}

/**
 * Generate a pseudo-random serial number
 */
function generateSerialNumber(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
