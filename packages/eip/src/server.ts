/**
 * EtherNet/IP CIP Server
 *
 * TCP server listening on port 44818 that handles:
 * - Encapsulation session management (RegisterSession, UnregisterSession)
 * - SendRRData for unconnected CIP messaging
 * - ReadTag (0x4C) and WriteTag (0x4D) services
 * - ListIdentity for device discovery
 */

import type { PlcEngine, TagStore } from "@plc-emulation/core";
import {
  EncapsulationCommand,
  EncapsulationStatus,
  ENCAP_HEADER_SIZE,
  encodeHeader,
  decodeHeader,
  type EncapsulationHeader,
} from "./encapsulation.ts";
import {
  CpfItemType,
  decodeCpf,
  encodeCpf,
  buildUnconnectedCpf,
  buildConnectedCpf,
} from "./cpf.ts";
import {
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
import { decodePath, segmentsToTagName, type PathSegment } from "./path.ts";
import {
  parseReadTagRequest,
  buildReadTagResponse,
  parseWriteTagRequest,
  CipDataType,
  plcTypeToCipDataType,
} from "./tag-services.ts";
import {
  createDefaultIdentity,
  encodeListIdentityResponse,
  type IdentityObject,
} from "./identity.ts";

/**
 * Server configuration options
 */
export interface EipServerOptions {
  /** PLC engine instance */
  engine: PlcEngine;
  /** Port to listen on (default: 44818) */
  port?: number;
  /** Hostname to bind to (default: '0.0.0.0') */
  hostname?: string;
  /** Device identity (optional, will use default if not provided) */
  identity?: IdentityObject;
  /** Maximum number of concurrent sessions */
  maxSessions?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Active session state
 */
interface Session {
  handle: number;
  socket: Socket;
  lastActivity: number;
}

/**
 * Socket-like interface for flexibility (works with Bun or Node)
 */
export interface Socket {
  remoteAddress: string;
  remotePort: number;
  write(data: Uint8Array): boolean | Promise<boolean>;
  end(): void;
  on(event: "data", handler: (data: Uint8Array) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  off(event: string, handler: unknown): void;
}

/**
 * Server handle returned by startEipServer
 */
export interface EipServerHandle {
  /** Server URL */
  url: string;
  /** Stop the server */
  stop(): Promise<void>;
  /** Number of active sessions */
  sessionCount: number;
}

// Session handle counter
let nextSessionHandle = 0x00000001;

/**
 * Start an EtherNet/IP CIP server
 *
 * Works with Bun.serve() API
 */
export function startEipServer(options: EipServerOptions): EipServerHandle {
  const port = options.port ?? 44818;
  const hostname = options.hostname ?? "0.0.0.0";
  const identity = options.identity ?? createDefaultIdentity();
  const maxSessions = options.maxSessions ?? 10;
  const debug = options.debug ?? false;

  const sessions = new Map<number, Session>();

  const log = (...args: unknown[]) => {
    if (debug) console.log("[EIP]", ...args);
  };

  // Create Bun server
  const server: {
    port: number;
    hostname: string;
    stop(closeActiveConnections?: boolean): void;
  } = Bun.listen({
    hostname,
    port,
    socket: {
      data(socket, data) {
        handleSocketData(socket as unknown as Socket, new Uint8Array(data));
      },
      close(socket) {
        handleSocketClose(socket as unknown as Socket);
      },
      error(socket, error) {
        log("Socket error:", error.message);
        handleSocketClose(socket as unknown as Socket);
      },
    },
  });

  log(`EtherNet/IP server listening on ${hostname}:${port}`);

  async function handleSocketData(socket: Socket, data: Uint8Array) {
    try {
      if (data.length < ENCAP_HEADER_SIZE) {
        log("Received data too short for header");
        return;
      }

      const { header, payload } = parsePacket(data);
      log(
        `Received command 0x${header.command.toString(16)}, session 0x${header.sessionHandle.toString(16)}`,
      );

      switch (header.command) {
        case EncapsulationCommand.RegisterSession:
          await handleRegisterSession(socket, header, payload);
          break;

        case EncapsulationCommand.UnregisterSession:
          await handleUnregisterSession(header);
          break;

        case EncapsulationCommand.SendRRData:
          await handleSendRRData(socket, header, payload);
          break;

        case EncapsulationCommand.SendUnitData:
          await handleSendUnitData(socket, header, payload);
          break;

        case EncapsulationCommand.ListIdentity:
          await handleListIdentity(socket, header);
          break;

        case EncapsulationCommand.ListServices:
          await handleListServices(socket, header);
          break;

        case EncapsulationCommand.NOP:
          // No response required for NOP
          log("NOP received");
          break;

        default:
          log(`Unknown command: 0x${header.command.toString(16)}`);
          await sendErrorResponse(socket, header, EncapsulationStatus.InvalidCommand);
      }
    } catch (err) {
      log("Error handling socket data:", err);
    }
  }

  function handleSocketClose(socket: Socket) {
    // Find and remove any sessions for this socket
    for (const [handle, session] of sessions.entries()) {
      if (session.socket === socket) {
        log(`Closing session 0x${handle.toString(16)}`);
        sessions.delete(handle);
        break;
      }
    }
  }

  async function handleRegisterSession(
    socket: Socket,
    header: EncapsulationHeader,
    payload: Uint8Array,
  ) {
    if (sessions.size >= maxSessions) {
      log("Max sessions reached, rejecting new session");
      await sendErrorResponse(socket, header, EncapsulationStatus.InsufficientMemory);
      return;
    }

    // Validate protocol version (first 2 bytes of payload)
    // Accept version 0x0100 (rev 1.0) or 0x0000 (some older clients)
    if (payload.length >= 2) {
      const view = new DataView(payload.buffer, payload.byteOffset);
      const protocolVersion = view.getUint16(0, true);
      if (protocolVersion > 0x0100) {
        log(`Unsupported protocol version: 0x${protocolVersion.toString(16)}`);
        await sendErrorResponse(socket, header, EncapsulationStatus.UnsupportedProtocolRevision);
        return;
      }
    }

    const sessionHandle = nextSessionHandle++;
    sessions.set(sessionHandle, {
      handle: sessionHandle,
      socket,
      lastActivity: Date.now(),
    });

    log(`Registered session 0x${sessionHandle.toString(16)}`);

    // Send success response with session handle
    const responseData = new Uint8Array(4);
    const view = new DataView(responseData.buffer);
    view.setUint16(0, 0x0100, true); // Protocol version
    view.setUint16(2, 0x0000, true); // Session options

    await sendResponse(
      socket,
      {
        command: EncapsulationCommand.RegisterSession,
        length: responseData.length,
        sessionHandle,
        status: EncapsulationStatus.Success,
        senderContext: header.senderContext,
        options: 0,
      },
      responseData,
    );
  }

  async function handleUnregisterSession(header: EncapsulationHeader) {
    const session = sessions.get(header.sessionHandle);
    if (session) {
      log(`Unregistered session 0x${header.sessionHandle.toString(16)}`);
      sessions.delete(header.sessionHandle);
    } else {
      log(`UnregisterSession for unknown handle: 0x${header.sessionHandle.toString(16)}`);
    }
    // No response for UnregisterSession
  }

  async function handleSendRRData(
    socket: Socket,
    header: EncapsulationHeader,
    payload: Uint8Array,
  ) {
    // Validate session
    const session = sessions.get(header.sessionHandle);
    if (!session) {
      log(`SendRRData with invalid session: 0x${header.sessionHandle.toString(16)}`);
      await sendErrorResponse(socket, header, EncapsulationStatus.InvalidSessionHandle);
      return;
    }

    session.lastActivity = Date.now();

    try {
      // Parse CPF from payload
      // Skip interface handle (4 bytes) and timeout (2 bytes)
      if (payload.length < 6) {
        throw new Error("SendRRData payload too short");
      }

      const cpfData = payload.slice(6);
      const cpfItems = decodeCpf(cpfData);

      // Find unconnected data item
      const unconnectedItem = cpfItems.find((item) => item.typeId === CpfItemType.UnconnectedData);
      if (!unconnectedItem) {
        throw new Error("No unconnected data item found");
      }

      // Parse CIP request from unconnected data
      const cipRequest = decodeCipRequest(unconnectedItem.data);

      // Handle the CIP service
      const cipResponse = await handleCipService(cipRequest, options.engine.tags);

      // Build CPF response
      const responseCpf = buildUnconnectedCpf(encodeCipResponse(cipResponse));

      // Build interface handle + timeout + CPF
      const responsePayload = new Uint8Array(6 + responseCpf.length);
      const view = new DataView(responsePayload.buffer);
      view.setUint32(0, 0, true); // Interface handle (0 = CIP)
      view.setUint16(4, 0, true); // Timeout
      responsePayload.set(responseCpf, 6);

      await sendResponse(
        socket,
        {
          command: EncapsulationCommand.SendRRData,
          length: responsePayload.length,
          sessionHandle: header.sessionHandle,
          status: EncapsulationStatus.Success,
          senderContext: header.senderContext,
          options: 0,
        },
        responsePayload,
      );
    } catch (err) {
      log("Error handling SendRRData:", err);
      await sendErrorResponse(socket, header, EncapsulationStatus.IncorrectData);
    }
  }

  async function handleSendUnitData(
    socket: Socket,
    header: EncapsulationHeader,
    payload: Uint8Array,
  ) {
    const session = sessions.get(header.sessionHandle);
    if (!session) {
      log(`SendUnitData with invalid session: 0x${header.sessionHandle.toString(16)}`);
      await sendErrorResponse(socket, header, EncapsulationStatus.InvalidSessionHandle);
      return;
    }

    session.lastActivity = Date.now();

    try {
      if (payload.length < 6) throw new Error("SendUnitData payload too short");
      const cpfItems = decodeCpf(payload.slice(6));
      const addressItem = cpfItems.find((item) => item.typeId === CpfItemType.ConnectedAddress);
      const dataItem = cpfItems.find((item) => item.typeId === CpfItemType.ConnectedData);
      if (!addressItem || !dataItem) throw new Error("No connected CPF items found");

      const addressView = new DataView(
        addressItem.data.buffer,
        addressItem.data.byteOffset,
        addressItem.data.byteLength,
      );
      const connectionId = addressItem.data.length >= 4 ? addressView.getUint32(0, true) : 0;

      // Connected data starts with a 16-bit sequence count followed by the CIP message.
      const sequence = dataItem.data.length >= 2 ? dataItem.data.slice(0, 2) : new Uint8Array(2);
      const cipRequest = decodeCipRequest(dataItem.data.slice(2));
      const cipResponse = await handleCipService(cipRequest, options.engine.tags);
      const encodedResponse = encodeCipResponse(cipResponse);
      const sequencedResponse = new Uint8Array(2 + encodedResponse.length);
      sequencedResponse.set(sequence, 0);
      sequencedResponse.set(encodedResponse, 2);

      const responseCpf = buildConnectedCpf(connectionId, sequencedResponse);
      const responsePayload = new Uint8Array(6 + responseCpf.length);
      const view = new DataView(responsePayload.buffer);
      view.setUint32(0, 0, true);
      view.setUint16(4, 0, true);
      responsePayload.set(responseCpf, 6);

      await sendResponse(
        socket,
        {
          command: EncapsulationCommand.SendUnitData,
          length: responsePayload.length,
          sessionHandle: header.sessionHandle,
          status: EncapsulationStatus.Success,
          senderContext: header.senderContext,
          options: 0,
        },
        responsePayload,
      );
    } catch (err) {
      log("Error handling SendUnitData:", err);
      await sendErrorResponse(socket, header, EncapsulationStatus.IncorrectData);
    }
  }

  async function handleListIdentity(socket: Socket, header: EncapsulationHeader) {
    log("ListIdentity request received");

    try {
      const socketInfo = {
        ipAddress: (socket as unknown as { localAddress?: string }).localAddress ?? "127.0.0.1",
        port,
      };

      const identityData = encodeListIdentityResponse(identity, socketInfo);

      // Build CPF with identity item
      const cpfItems = new Uint8Array(4 + identityData.length);
      const view = new DataView(cpfItems.buffer);
      view.setUint16(0, 1, true); // Item count = 1
      view.setUint16(2, CpfItemType.ListIdentity, true); // Item type
      // Item length and data follow
      const fullCpf = new Uint8Array(4 + cpfItems.length + identityData.length);
      const fullView = new DataView(fullCpf.buffer);
      fullView.setUint16(0, 1, true); // Item count
      fullView.setUint16(2, CpfItemType.ListIdentity, true); // Type
      fullView.setUint16(4, identityData.length, true); // Length
      fullCpf.set(identityData, 6);

      await sendResponse(
        socket,
        {
          command: EncapsulationCommand.ListIdentity,
          length: fullCpf.length,
          sessionHandle: 0,
          status: EncapsulationStatus.Success,
          senderContext: header.senderContext,
          options: 0,
        },
        fullCpf,
      );
    } catch (err) {
      log("Error handling ListIdentity:", err);
      await sendErrorResponse(socket, header, EncapsulationStatus.IncorrectData);
    }
  }

  async function handleListServices(socket: Socket, header: EncapsulationHeader) {
    log("ListServices request received");

    // Return minimal services list - just CIP
    const cipServiceName = new TextEncoder().encode("Communications\x00");
    const itemData = new Uint8Array(2 + cipServiceName.length);
    const view = new DataView(itemData.buffer);
    view.setUint16(0, 0x0100, true); // Protocol version
    itemData.set(cipServiceName, 2);

    // Build CPF
    const cpf = new Uint8Array(6 + itemData.length);
    const cpfView = new DataView(cpf.buffer);
    cpfView.setUint16(0, 1, true); // Item count
    cpfView.setUint16(2, 0x0100, true); // Type for service list item
    cpfView.setUint16(4, itemData.length, true);
    cpf.set(itemData, 6);

    await sendResponse(
      socket,
      {
        command: EncapsulationCommand.ListServices,
        length: cpf.length,
        sessionHandle: 0,
        status: EncapsulationStatus.Success,
        senderContext: header.senderContext,
        options: 0,
      },
      cpf,
    );
  }

  async function handleCipService(request: CipRequest, tags: TagStore): Promise<CipResponse> {
    const serviceHex = `0x${request.service.toString(16).padStart(2, "0")}`;
    const expectedHex = `0x${CipServiceCode.GetInstanceAttributeList.toString(16).padStart(2, "0")}`;
    log(
      `CIP service ${serviceHex}, expected GetInstanceAttributeList=${expectedHex}, match=${request.service === CipServiceCode.GetInstanceAttributeList}`,
    );

    if (request.service === CipServiceCode.ForwardClose && isConnectionManagerPath(request.path)) {
      return createSuccessResponse(request.service);
    }

    // Explicit check for GetInstanceAttributeList before switch
    if (request.service === 0x55) {
      log("Matched GetInstanceAttributeList via explicit check");
      return handleGetInstanceAttributeList(request, tags);
    }

    switch (request.service) {
      case CipServiceCode.ForwardOpen:
      case CipServiceCode.LargeForwardOpen:
        return handleForwardOpen(request);

      case CipServiceCode.UnconnectedSend:
        return isConnectionManagerPath(request.path)
          ? handleUnconnectedSendService(request, tags)
          : handleReadTag(request, tags);

      case CipServiceCode.ReadTag:
        return handleReadTag(request, tags);

      case CipServiceCode.WriteTag:
        return handleWriteTag(request, tags);

      case CipServiceCode.GetAttributeAll:
        return handleGetAttributeAll(request, tags);

      case CipServiceCode.GetAttributeSingle:
        return handleGetAttributeSingle(request, tags);

      case CipServiceCode.GetInstanceAttributeList:
        log("Matched GetInstanceAttributeList via switch case");
        return handleGetInstanceAttributeList(request, tags);

      default:
        log(`Unsupported CIP service: 0x${request.service.toString(16)}`);
        return createErrorResponse(request.service, CipStatus.ServiceNotSupported);
    }
  }

  function isConnectionManagerPath(path: Uint8Array): boolean {
    try {
      const segments = decodePath(path);
      return segments.some((s) => s.type === "class" && s.classId === 0x06);
    } catch {
      return false;
    }
  }

  function handleForwardOpen(request: CipRequest): CipResponse {
    const data = new Uint8Array(26);
    const view = new DataView(data.buffer);
    // O->T and T->O connection IDs. We accept any ID on SendUnitData, but
    // libplctag expects IDs in this response before using connected messages.
    view.setUint32(0, 0x20000001, true);
    view.setUint32(4, 0x20000002, true);

    // Echo connection serial/vendor/originator serial if present. In normal and
    // large ForwardOpen these fields start at byte 8 of the request data.
    if (request.data.length >= 16) {
      data.set(request.data.slice(8, 16), 8);
    }

    // O->T/T->O actual packet intervals and application reply size remain zero.
    return createSuccessResponse(request.service, data);
  }

  async function handleUnconnectedSendService(
    request: CipRequest,
    tags: TagStore,
  ): Promise<CipResponse> {
    try {
      // Connection Manager Unconnected_Send (0x52) wraps another CIP request in
      // its data area. Many Logix clients use this for tag browsing.
      // Data layout: priority/time_tick (1), timeout_ticks (1), message_size
      // UINT, embedded_message, route_path_size (1), reserved (1), route_path.
      if (request.data.length < 4) {
        return createErrorResponse(request.service, CipStatus.InsufficientData);
      }

      const view = new DataView(
        request.data.buffer,
        request.data.byteOffset,
        request.data.byteLength,
      );
      const messageSize = view.getUint16(2, true);
      if (request.data.length < 4 + messageSize) {
        return createErrorResponse(request.service, CipStatus.InsufficientData);
      }

      const embeddedRequest = decodeCipRequest(request.data.slice(4, 4 + messageSize));
      // Return the embedded response as the CIP response. This matches common
      // client behavior for SendRRData helpers, including the local explorer.
      return handleCipService(embeddedRequest, tags);
    } catch (err) {
      log("Error handling UnconnectedSend:", err);
      return createErrorResponse(request.service, CipStatus.InvalidParameterValue);
    }
  }

  function handleReadTag(request: CipRequest, tags: TagStore): CipResponse {
    try {
      const { tagPath, elementCount } = parseReadTagRequest(request);
      log(`ReadTag: ${tagPath}[${elementCount}]`);

      // Get tag value from PLC engine
      const tagValue = tags.get(tagPath);
      const tagInfo = tags.list().find((t) => t.canonicalPath === tagPath);

      if (tagValue === undefined) {
        log(`Tag not found: ${tagPath}`);
        return createErrorResponse(request.service, CipStatus.ObjectDoesNotExist);
      }

      // Determine CIP data type. For member paths and runtime-created tags,
      // prefer the actual value shape over defaulting to DINT.
      const typeName = tagInfo?.declaration?.type;
      const cipType = cipTypeForRead(typeName, tagValue);

      // Build response data
      const values = Array.isArray(tagValue) ? tagValue : [tagValue];
      const responseData = buildReadTagResponse(cipType, values.slice(0, elementCount));

      return createSuccessResponse(request.service, responseData);
    } catch (err) {
      log("Error handling ReadTag:", err);
      return createErrorResponse(request.service, CipStatus.InvalidParameterValue);
    }
  }

  function handleWriteTag(request: CipRequest, tags: TagStore): CipResponse {
    try {
      const { tagPath, type, values } = parseWriteTagRequest(request);
      log(`WriteTag: ${tagPath} = ${JSON.stringify(values)} (type 0x${type.toString(16)})`);

      // Write value to PLC engine
      const valueToWrite = values.length === 1 ? values[0] : values;
      tags.set(tagPath, valueToWrite);

      return createSuccessResponse(request.service);
    } catch (err) {
      log("Error handling WriteTag:", err);
      return createErrorResponse(request.service, CipStatus.InvalidParameterValue);
    }
  }

  function handleGetAttributeAll(request: CipRequest, tags: TagStore): CipResponse {
    // This would handle Identity object GetAttributeAll
    // For now, return not supported
    return createErrorResponse(request.service, CipStatus.ServiceNotSupported);
  }

  function handleGetAttributeSingle(request: CipRequest, tags: TagStore): CipResponse {
    // Handle single attribute reads (often used for Identity object)
    return createErrorResponse(request.service, CipStatus.ServiceNotSupported);
  }

  function handleGetInstanceAttributeList(request: CipRequest, tags: TagStore): CipResponse {
    // Parse the path to get class/instance
    const segments = decodePath(request.path);
    const classSegment = segments.find((s) => s.type === "class");

    // Symbol Object Class (0x6B) is used for tag browsing
    if (!classSegment || classSegment.classId !== 0x6b) {
      log(`GetInstanceAttributeList: unsupported class ${classSegment?.classId ?? "none"}`);
      return createErrorResponse(request.service, CipStatus.ObjectDoesNotExist);
    }

    try {
      // Parse request data: [attribute_count: uint16] [attribute_ids...]
      // The starting instance is encoded in the Symbol Object EPATH.
      const instanceSegment = segments.find((s) => s.type === "instance");
      const startingInstance = instanceSegment?.instanceId ?? 0;
      const view = new DataView(
        request.data.buffer,
        request.data.byteOffset,
        request.data.byteLength,
      );
      let offset = 0;

      const attributeCount = view.getUint16(offset, true);
      offset += 2;

      const requestedAttrs: number[] = [];
      for (let i = 0; i < attributeCount; i++) {
        requestedAttrs.push(view.getUint16(offset, true));
        offset += 2;
      }

      log(
        `Browse tags from instance ${startingInstance}, attrs: [${requestedAttrs.map((a) => `0x${a.toString(16)}`).join(", ")}]`,
      );

      // Get all tags from the store
      const allTags = tags.list();
      const startIdx = startingInstance > 0 ? startingInstance - 1 : 0;

      if (startIdx >= allTags.length) {
        // No more instances
        return createSuccessResponse(request.service, new Uint8Array(0));
      }

      // Build response with tag info
      // Format: [instance_id: uint32] [requested attribute data...] ...
      const responseChunks: Uint8Array[] = [];
      let remaining = allTags.length - startIdx;

      // Limit to reasonable number per response (say 10)
      const batchSize = Math.min(10, remaining);
      remaining -= batchSize;

      for (let i = 0; i < batchSize; i++) {
        const tag = allTags[startIdx + i]!;
        const tagName = tag.canonicalPath;

        // Encode each instance entry
        // [instance_id: uint32] [attribute_data...]
        const instanceId = startIdx + i + 1;

        // Instance entry: [instance_id: uint32] [attr_id: uint16] [attr_data...] ...
        const attrChunks: Uint8Array[] = [];

        for (const attrId of requestedAttrs) {
          switch (attrId) {
            case 0x01: {
              // Symbol Name - length-counted ANSI string.
              const nameBytes = new TextEncoder().encode(tagName);
              const attrData = new Uint8Array(2 + nameBytes.length);
              const attrView = new DataView(attrData.buffer);
              attrView.setUint16(0, nameBytes.length, true);
              attrData.set(nameBytes, 2);
              attrChunks.push(attrData);
              break;
            }
            case 0x02: {
              // Symbol Type - UINT Logix type word. Default to DINT.
              const attrData = new Uint8Array(2);
              const attrView = new DataView(attrData.buffer);
              attrView.setUint16(0, symbolTypeForTag(tag, tags.get(tagName)), true);
              attrChunks.push(attrData);
              break;
            }
            case 0x07: {
              // Element length in bytes, used by libplctag @tags.
              const attrData = new Uint8Array(2);
              const attrView = new DataView(attrData.buffer);
              attrView.setUint16(0, elementByteLengthForTag(tag, tags.get(tagName)), true);
              attrChunks.push(attrData);
              break;
            }
            case 0x08: {
              // Array dimensions: 3 x UDINT. Scalars are all zero.
              const attrData = new Uint8Array(12);
              const attrView = new DataView(attrData.buffer);
              const value = tags.get(tagName);
              if (Array.isArray(value)) {
                attrView.setUint32(0, value.length, true);
              }
              attrChunks.push(attrData);
              break;
            }
            default:
              // Unknown attribute - skip
              break;
          }
        }

        // Combine instance header with all attributes
        const totalAttrLen = attrChunks.reduce((sum, c) => sum + c.length, 0);
        const entry = new Uint8Array(4 + totalAttrLen);
        const entryView = new DataView(entry.buffer);
        entryView.setUint32(0, instanceId, true);
        let pos = 4;
        for (const chunk of attrChunks) {
          entry.set(chunk, pos);
          pos += chunk.length;
        }
        responseChunks.push(entry);
      }

      const totalLen = responseChunks.reduce((sum, c) => sum + c.length, 0);
      const responseData = new Uint8Array(totalLen);

      let pos = 0;
      for (const chunk of responseChunks) {
        responseData.set(chunk, pos);
        pos += chunk.length;
      }

      log(`Returning ${batchSize} tags, ${remaining} remaining`);
      return {
        service: request.service | CIP_REPLY_BIT,
        status: remaining > 0 ? CipStatus.PartialTransfer : CipStatus.Success,
        extendedStatus: [],
        data: responseData,
      };
    } catch (err) {
      log("Error handling GetInstanceAttributeList:", err);
      return createErrorResponse(request.service, CipStatus.InvalidParameterValue);
    }
  }

  function symbolTypeForTag(tag: ReturnType<TagStore["list"]>[number], value: unknown): number {
    const type = tag.declaration?.type;
    const arrayRank = arrayRankFor(type, value);
    const arrayBits = arrayRank > 0 ? Math.min(arrayRank, 3) << 13 : 0;

    if (type === "TIMER" || looksLikeTimer(value)) return arrayBits | 0x8000 | 0x0e;
    if (type === "COUNTER" || looksLikeCounter(value)) return arrayBits | 0x8000 | 0x0f;
    if (type === "CONTROL" || looksLikeControl(value)) return arrayBits | 0x8000 | 0x10;
    if (typeof type === "object" && type && "kind" in type && type.kind === "struct") {
      return arrayBits | 0x8000 | stableTemplateId(tag.canonicalPath);
    }
    if (!type && value && typeof value === "object" && !Array.isArray(value)) {
      return arrayBits | 0x8000 | stableTemplateId(tag.canonicalPath);
    }

    const elementType =
      typeof type === "object" && type && "kind" in type && type.kind === "array"
        ? type.elementType
        : type;
    const cipType =
      typeof elementType === "string"
        ? plcTypeToCipDataType(elementType)
        : inferCipTypeFromValue(value);
    return arrayBits | (cipType ?? CipDataType.DINT);
  }

  function elementByteLengthForTag(
    tag: ReturnType<TagStore["list"]>[number],
    value: unknown,
  ): number {
    const type = tag.declaration?.type;
    if (
      type === "TIMER" ||
      type === "COUNTER" ||
      type === "CONTROL" ||
      looksLikeTimer(value) ||
      looksLikeCounter(value) ||
      looksLikeControl(value)
    )
      return 12;
    if (typeof type === "object" && type && "kind" in type && type.kind === "struct") {
      return Object.keys(type.members ?? {}).length * 4;
    }
    if (!type && value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).length * 4;
    }

    const elementType =
      typeof type === "object" && type && "kind" in type && type.kind === "array"
        ? type.elementType
        : type;
    const cipType =
      typeof elementType === "string"
        ? plcTypeToCipDataType(elementType)
        : inferCipTypeFromValue(value);
    return cipTypeByteLength(cipType ?? CipDataType.DINT);
  }

  function cipTypeForRead(type: unknown, value: unknown): CipDataType {
    if (typeof type === "string")
      return plcTypeToCipDataType(type) ?? inferCipTypeFromValue(value) ?? CipDataType.DINT;
    return inferCipTypeFromValue(value) ?? CipDataType.DINT;
  }

  function arrayRankFor(type: unknown, value: unknown): number {
    if (typeof type === "object" && type && "kind" in type && type.kind === "array") {
      const arrayType = type as { dimensions?: unknown[] };
      return Array.isArray(arrayType.dimensions) ? arrayType.dimensions.length : 1;
    }
    return Array.isArray(value) ? 1 : 0;
  }

  function inferCipTypeFromValue(value: unknown): CipDataType | undefined {
    if (Array.isArray(value)) return inferCipTypeFromValue(value[0]);
    if (typeof value === "boolean") return CipDataType.BOOL;
    if (typeof value === "number")
      return Number.isInteger(value) ? CipDataType.DINT : CipDataType.REAL;
    if (typeof value === "bigint") return CipDataType.LINT;
    if (typeof value === "string") return CipDataType.STRING;
    return undefined;
  }

  function looksLikeCounter(value: unknown): boolean {
    return hasKeys(value, ["PRE", "ACC", "CU", "CD", "DN"]);
  }

  function looksLikeTimer(value: unknown): boolean {
    return hasKeys(value, ["PRE", "ACC", "EN", "TT", "DN"]);
  }

  function looksLikeControl(value: unknown): boolean {
    return hasKeys(value, ["LEN", "POS", "EN", "DN"]);
  }

  function hasKeys(value: unknown, keys: string[]): boolean {
    return !!value && typeof value === "object" && keys.every((key) => key in value);
  }

  function stableTemplateId(name: string): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0x0fff;
    return hash || 1;
  }

  function cipTypeByteLength(type: CipDataType): number {
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
        return 4;
    }
  }

  async function sendResponse(socket: Socket, header: EncapsulationHeader, payload: Uint8Array) {
    const headerBuf = encodeHeader(header);
    const fullPacket = new Uint8Array(headerBuf.length + payload.length);
    fullPacket.set(headerBuf);
    fullPacket.set(payload, headerBuf.length);

    await socket.write(fullPacket);
  }

  async function sendErrorResponse(
    socket: Socket,
    requestHeader: EncapsulationHeader,
    status: EncapsulationStatus,
  ) {
    await sendResponse(
      socket,
      {
        command: requestHeader.command,
        length: 0,
        sessionHandle: requestHeader.sessionHandle,
        status,
        senderContext: requestHeader.senderContext,
        options: 0,
      },
      new Uint8Array(0),
    );
  }

  function parsePacket(data: Uint8Array): { header: EncapsulationHeader; payload: Uint8Array } {
    const header = decodeHeader(data);
    const payload = data.slice(ENCAP_HEADER_SIZE, ENCAP_HEADER_SIZE + header.length);
    return { header, payload };
  }

  return {
    url: `eip://${server.hostname}:${server.port}`,
    async stop() {
      log("Stopping EtherNet/IP server");
      server.stop();
      sessions.clear();
    },
    get sessionCount() {
      return sessions.size;
    },
  };
}

/**
 * Decode a CIP request from raw bytes
 */
function decodeCipRequest(data: Uint8Array): CipRequest {
  if (data.length < 2) {
    throw new Error("CIP request too short");
  }

  const service = data[0]!;
  const pathSizeWords = data[1]!;
  const pathLength = pathSizeWords * 2;

  if (data.length < 2 + pathLength) {
    throw new Error("CIP request path truncated");
  }

  const path = data.slice(2, 2 + pathLength);
  const requestData = data.slice(2 + pathLength);

  return { service, path, data: requestData };
}
