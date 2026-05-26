/**
 * Common Packet Format (CPF)
 *
 * CPF is the container format used within SendRRData and SendUnitData.
 * It consists of an item count followed by CPF items.
 *
 * Wire layout:
 * ```
 * Offset  Size  Field
 * 0       2     itemCount (uint16 LE)
 *
 * Per item:
 * 0       2     typeId (uint16 LE)
 * 2       2     length (uint16 LE)
 * 4       N     data (N = length)
 * ```
 */

/**
 * Well-known CPF item type IDs
 */
export enum CpfItemType {
  /** Null Address item - used in unconnected messages */
  NullAddress = 0x0000,
  /** ListIdentity Response item */
  ListIdentity = 0x000c,
  /** Connected Address item - carries connection ID */
  ConnectedAddress = 0x00a1,
  /** Connected Data item - carries connected transport data */
  ConnectedData = 0x00b1,
  /** Unconnected Data item - carries unconnected CIP message */
  UnconnectedData = 0x00b2,
  /** Sequenced Address item - for Class 1 I/O transport */
  SequencedAddress = 0x8002,
}

/**
 * A CPF item
 */
export interface CpfItem {
  typeId: number;
  data: Uint8Array;
}

/**
 * Encode an array of CPF items
 */
export function encodeCpf(items: CpfItem[]): Uint8Array {
  // Calculate total size: 2 (count) + sum(4 + data.length) per item
  let totalSize = 2;
  for (const item of items) {
    totalSize += 4 + item.data.length;
  }

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  // Item count
  view.setUint16(offset, items.length, true);
  offset += 2;

  for (const item of items) {
    view.setUint16(offset, item.typeId, true);
    offset += 2;
    view.setUint16(offset, item.data.length, true);
    offset += 2;

    if (item.data.length > 0) {
      buf.set(item.data, offset);
      offset += item.data.length;
    }
  }

  return buf;
}

/**
 * Decode a CPF structure
 */
export function decodeCpf(data: Uint8Array): CpfItem[] {
  if (data.length < 2) {
    throw new Error(`CPF data too short: need at least 2 bytes, got ${data.length}`);
  }

  const view = new DataView(data.buffer, data.byteOffset);
  const itemCount = view.getUint16(0, true);
  let offset = 2;
  const items: CpfItem[] = [];

  for (let i = 0; i < itemCount; i++) {
    if (offset + 4 > data.length) {
      throw new Error(`CPF data truncated at item ${i}`);
    }

    const typeId = view.getUint16(offset, true);
    offset += 2;
    const itemLength = view.getUint16(offset, true);
    offset += 2;

    if (offset + itemLength > data.length) {
      throw new Error(`CPF item ${i} data truncated`);
    }

    const itemData = data.slice(offset, offset + itemLength);
    offset += itemLength;

    items.push({ typeId, data: itemData });
  }

  return items;
}

/**
 * Build CPF items for unconnected SendRRData (Null Address + Unconnected Data)
 */
export function buildUnconnectedCpf(cipMessage: Uint8Array): Uint8Array {
  return encodeCpf([
    { typeId: CpfItemType.NullAddress, data: new Uint8Array(0) },
    { typeId: CpfItemType.UnconnectedData, data: cipMessage },
  ]);
}

/**
 * Build CPF items for connected SendUnitData (Connected Address + Connected Data)
 */
export function buildConnectedCpf(connectionId: number, cipMessage: Uint8Array): Uint8Array {
  const addressData = new Uint8Array(4);
  const view = new DataView(addressData.buffer);
  view.setUint32(0, connectionId, true);

  return encodeCpf([
    { typeId: CpfItemType.ConnectedAddress, data: addressData },
    { typeId: CpfItemType.ConnectedData, data: cipMessage },
  ]);
}
