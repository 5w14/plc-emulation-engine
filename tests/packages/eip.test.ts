/**
 * Tests for @plc-emulation/eip package
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createPlcEngine } from "@plc-emulation/core";
import {
  startEipServer,
  encodeHeader,
  decodeHeader,
  EncapsulationCommand,
  EncapsulationStatus,
  ENCAP_HEADER_SIZE,
  encodeCpf,
  decodeCpf,
  CpfItemType,
  encodeCipRequest,
  decodeCipResponse,
  CipServiceCode,
  CipStatus,
  CIP_REPLY_BIT,
  encodeTagPath,
  decodePath,
  encodeSymbolicSegment,
  CipDataType,
  readDataType,
  writeDataType,
  buildReadTagRequest,
  parseReadTagRequest,
  buildWriteTagRequest,
  parseWriteTagRequest,
} from "../../packages/eip/src/index";

describe("@plc-emulation/eip", () => {
  describe("encapsulation layer", () => {
    test("encode and decode header", () => {
      const senderContext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const header = {
        command: EncapsulationCommand.RegisterSession,
        length: 4,
        sessionHandle: 0x12345678,
        status: EncapsulationStatus.Success,
        senderContext,
        options: 0,
      };

      const encoded = encodeHeader(header);
      expect(encoded.length).toBe(ENCAP_HEADER_SIZE);

      const decoded = decodeHeader(encoded);
      expect(decoded.command).toBe(header.command);
      expect(decoded.length).toBe(header.length);
      expect(decoded.sessionHandle).toBe(header.sessionHandle);
      expect(decoded.status).toBe(header.status);
      expect(decoded.options).toBe(header.options);
      expect(decoded.senderContext).toEqual(senderContext);
    });

    test("decode header from buffer", () => {
      // Build a known-good header manually
      const buf = new Uint8Array(24);
      const view = new DataView(buf.buffer);
      view.setUint16(0, 0x0065, true); // RegisterSession
      view.setUint16(2, 4, true); // length
      view.setUint32(4, 0x12345678, true); // session handle
      view.setUint32(8, 0, true); // status
      // sender context (8 bytes at offset 12)
      buf.set([1, 2, 3, 4, 5, 6, 7, 8], 12);
      view.setUint32(20, 0, true); // options

      const decoded = decodeHeader(buf);
      expect(decoded.command).toBe(EncapsulationCommand.RegisterSession);
      expect(decoded.sessionHandle).toBe(0x12345678);
    });
  });

  describe("CPF (Common Packet Format)", () => {
    test("encode and decode CPF items", () => {
      const items = [
        { typeId: CpfItemType.NullAddress, data: new Uint8Array(0) },
        {
          typeId: CpfItemType.UnconnectedData,
          data: new Uint8Array([0x4c, 0x91, 0x04, 0x54, 0x65, 0x73, 0x74]),
        },
      ];

      const encoded = encodeCpf(items);
      const decoded = decodeCpf(encoded);

      expect(decoded.length).toBe(2);
      expect(decoded[0].typeId).toBe(CpfItemType.NullAddress);
      expect(decoded[0].data.length).toBe(0);
      expect(decoded[1].typeId).toBe(CpfItemType.UnconnectedData);
      expect(decoded[1].data).toEqual(items[1].data);
    });
  });

  describe("CIP encoding/decoding", () => {
    test("encode and decode CIP request", () => {
      const path = new Uint8Array([0x91, 0x04, 0x54, 0x65, 0x73, 0x74]); // "Test"
      const data = new Uint8Array([0x01, 0x00]); // element count = 1

      const request = {
        service: CipServiceCode.ReadTag,
        path,
        data,
      };

      const encoded = encodeCipRequest(request);
      expect(encoded[0]).toBe(CipServiceCode.ReadTag);
      expect(encoded[1]).toBe(3); // path size in words (6 bytes / 2)
    });

    test("decode CIP response", () => {
      // Build a success response
      const buf = new Uint8Array([
        CipServiceCode.ReadTag | CIP_REPLY_BIT, // reply service
        0x00, // reserved
        CipStatus.Success, // status
        0x00, // extended status size
        0xc4,
        0x00, // data type = DINT
        0x2a,
        0x00,
        0x00,
        0x00, // value = 42
      ]);

      const response = decodeCipResponse(buf);
      expect(response.service).toBe(CipServiceCode.ReadTag | CIP_REPLY_BIT);
      expect(response.status).toBe(CipStatus.Success);
      expect(response.extendedStatus.length).toBe(0);
      expect(response.data.length).toBe(6); // type + value
    });
  });

  describe("EPATH encoding/decoding", () => {
    test("encode symbolic segment", () => {
      const encoded = encodeSymbolicSegment("MyTag");
      expect(encoded[0]).toBe(0x91); // ANSI Extended Symbol
      expect(encoded[1]).toBe(5); // length
      expect(new TextDecoder().decode(encoded.slice(2, 7))).toBe("MyTag");
    });

    test("encode tag path", () => {
      const path = encodeTagPath("MyTag");
      expect(path[0]).toBe(0x91);
      expect(path[1]).toBe(5);
    });

    test("encode tag path with array index", () => {
      const path = encodeTagPath("MyArray[5]");
      // Should be: symbolic("MyArray") + member(5)
      expect(path[0]).toBe(0x91);
      expect(path[1]).toBe(7); // "MyArray"
      // After the symbolic segment (2 + 7 + 1 pad = 10 bytes), should be member segment
      expect(path[10]).toBe(0x28); // Member segment, 8-bit format
      expect(path[11]).toBe(5); // index
    });

    test("decode path segments", () => {
      const path = encodeTagPath("TestTag[3]");
      const segments = decodePath(path);

      expect(segments.length).toBe(2);
      expect(segments[0]).toEqual({ type: "symbolic", name: "TestTag" });
      expect(segments[1]).toEqual({ type: "member", memberId: 3 });
    });
  });

  describe("data types", () => {
    test("read and write BOOL", () => {
      const buf = new Uint8Array(1);
      writeDataType(buf, 0, CipDataType.BOOL, true);
      expect(buf[0]).toBe(1);

      const result = readDataType(buf, 0, CipDataType.BOOL);
      expect(result.value).toBe(true);
      expect(result.bytesRead).toBe(1);
    });

    test("read and write DINT", () => {
      const buf = new Uint8Array(4);
      writeDataType(buf, 0, CipDataType.DINT, 42);

      const view = new DataView(buf.buffer);
      expect(view.getInt32(0, true)).toBe(42);

      const result = readDataType(buf, 0, CipDataType.DINT);
      expect(result.value).toBe(42);
      expect(result.bytesRead).toBe(4);
    });

    test("read and write REAL", () => {
      const buf = new Uint8Array(4);
      writeDataType(buf, 0, CipDataType.REAL, 3.14159);

      const result = readDataType(buf, 0, CipDataType.REAL);
      expect(Math.abs((result.value as number) - 3.14159)).toBeLessThan(0.0001);
    });

    test("read and write STRING", () => {
      const buf = new Uint8Array(100);
      const written = writeDataType(buf, 0, CipDataType.STRING, "Hello");

      const result = readDataType(buf, 0, CipDataType.STRING);
      expect(result.value).toBe("Hello");
      expect(result.bytesRead).toBe(4 + 5); // length prefix + string
    });
  });

  describe("tag services", () => {
    test("build ReadTag request", () => {
      const request = buildReadTagRequest("MyTag", 1);
      expect(request.service).toBe(CipServiceCode.ReadTag);
      expect(request.data.length).toBe(2);

      const view = new DataView(request.data.buffer);
      expect(view.getUint16(0, true)).toBe(1);
    });

    test("parse ReadTag request", () => {
      const request = buildReadTagRequest("TestArray[5]", 3);
      const parsed = parseReadTagRequest(request);

      expect(parsed.tagPath).toBe("TestArray[5]");
      expect(parsed.elementCount).toBe(3);
    });

    test("build and parse WriteTag request", () => {
      const request = buildWriteTagRequest("Counter", CipDataType.DINT, [100]);
      expect(request.service).toBe(CipServiceCode.WriteTag);

      const parsed = parseWriteTagRequest(request);
      expect(parsed.tagPath).toBe("Counter");
      expect(parsed.type).toBe(CipDataType.DINT);
      expect(parsed.values).toEqual([100]);
    });
  });

  describe("EIP server integration", () => {
    let engine: ReturnType<typeof createPlcEngine>;
    let server: ReturnType<typeof startEipServer>;

    beforeEach(() => {
      engine = createPlcEngine();
      engine.tags.declare({ name: "TestDINT", type: "DINT", initialValue: 42 });
      engine.tags.declare({ name: "TestBOOL", type: "BOOL", initialValue: true });
      engine.tags.declare({ name: "TestREAL", type: "REAL", initialValue: 3.14 });

      server = startEipServer({ engine, port: 0, debug: false });
    });

    afterEach(async () => {
      await server.stop();
    });

    test("server starts and provides URL", () => {
      expect(server.url).toContain("eip://");
      expect(server.sessionCount).toBe(0);
    });

    test("RegisterSession creates new session", async () => {
      // Build RegisterSession request
      const senderContext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const protocolData = new Uint8Array(4);
      const view = new DataView(protocolData.buffer);
      view.setUint16(0, 0x0100, true); // protocol version
      view.setUint16(2, 0, true); // options

      const request = buildEncapsulationPacket(
        EncapsulationCommand.RegisterSession,
        0,
        senderContext,
        protocolData,
      );

      const response = await connectAndExchange(server.url, request);
      const header = decodeHeader(response);

      expect(header.command).toBe(EncapsulationCommand.RegisterSession);
      expect(header.status).toBe(EncapsulationStatus.Success);
      expect(header.sessionHandle).toBeGreaterThan(0);
      expect(header.senderContext).toEqual(senderContext);
    });

    test("SendRRData with ReadTag service", async () => {
      const match = server.url.match(/eip:\/\/([^:]+):(\d+)/);
      if (!match) throw new Error(`Invalid URL: ${server.url}`);

      const hostname = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1];
      const port = parseInt(match[2], 10);

      // Use a persistent connection for both RegisterSession and SendRRData
      const response = await new Promise<Uint8Array>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);
        let state: "registering" | "sending" | "done" = "registering";
        let responseData = new Uint8Array();
        let sessionHandle = 0;

        Bun.connect({
          hostname,
          port,
          socket: {
            data(_socket, data) {
              if (state === "registering") {
                const header = decodeHeader(new Uint8Array(data));
                if (header.status === EncapsulationStatus.Success) {
                  sessionHandle = header.sessionHandle;
                  state = "sending";

                  // Now send the ReadTag request on same connection
                  const cipRequest = buildReadTagRequest("TestDINT", 1);
                  const cipData = encodeCipRequest(cipRequest);
                  const cpfData = encodeCpf([
                    { typeId: CpfItemType.NullAddress, data: new Uint8Array(0) },
                    { typeId: CpfItemType.UnconnectedData, data: cipData },
                  ]);
                  const payload = new Uint8Array(6 + cpfData.length);
                  const view = new DataView(payload.buffer);
                  view.setUint32(0, 0, true);
                  view.setUint16(4, 0, true);
                  payload.set(cpfData, 6);

                  const request = buildEncapsulationPacket(
                    EncapsulationCommand.SendRRData,
                    sessionHandle,
                    new Uint8Array(8),
                    payload,
                  );
                  _socket.write(request);
                } else {
                  clearTimeout(timeout);
                  resolve(new Uint8Array(data));
                }
              } else if (state === "sending") {
                responseData = new Uint8Array(data);
                state = "done";
                clearTimeout(timeout);
                resolve(responseData);
              }
            },
            close() {
              if (state !== "done") {
                clearTimeout(timeout);
                resolve(responseData);
              }
            },
            error(_socket, error) {
              clearTimeout(timeout);
              reject(error);
            },
            open(socket) {
              // Send RegisterSession first
              const protocolData = new Uint8Array(4);
              const view = new DataView(protocolData.buffer);
              view.setUint16(0, 0x0100, true);
              view.setUint16(2, 0, true);
              const request = buildEncapsulationPacket(
                EncapsulationCommand.RegisterSession,
                0,
                new Uint8Array(8),
                protocolData,
              );
              socket.write(request);
            },
          },
        });
      });

      const responseHeader = decodeHeader(response);

      expect(responseHeader.command).toBe(EncapsulationCommand.SendRRData);
      expect(responseHeader.status).toBe(EncapsulationStatus.Success);

      // Parse response payload
      const responsePayload = response.slice(ENCAP_HEADER_SIZE + 6); // Skip header + interface/timeout
      const responseCpf = decodeCpf(responsePayload);

      // Find the UnconnectedData item (type 0x00B2)
      const unconnectedItem = responseCpf.find(
        (item) => item.typeId === CpfItemType.UnconnectedData,
      );
      expect(unconnectedItem).toBeDefined();

      const cipResponse = decodeCipResponse(unconnectedItem!.data);

      expect(cipResponse.status).toBe(CipStatus.Success);
      expect(cipResponse.service).toBe(CipServiceCode.ReadTag | CIP_REPLY_BIT);
    });

    test("SendRRData with WriteTag service", async () => {
      const match = server.url.match(/eip:\/\/([^:]+):(\d+)/);
      if (!match) throw new Error(`Invalid URL: ${server.url}`);

      const hostname = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1];
      const port = parseInt(match[2], 10);

      // Use a persistent connection
      const response = await new Promise<Uint8Array>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);
        let state: "registering" | "sending" | "done" = "registering";
        let responseData = new Uint8Array();
        let sessionHandle = 0;

        Bun.connect({
          hostname,
          port,
          socket: {
            data(_socket, data) {
              if (state === "registering") {
                const header = decodeHeader(new Uint8Array(data));
                if (header.status === EncapsulationStatus.Success) {
                  sessionHandle = header.sessionHandle;
                  state = "sending";

                  // Send WriteTag request
                  const cipRequest = buildWriteTagRequest("TestDINT", CipDataType.DINT, [12345]);
                  const cipData = encodeCipRequest(cipRequest);
                  const cpfData = encodeCpf([
                    { typeId: CpfItemType.NullAddress, data: new Uint8Array(0) },
                    { typeId: CpfItemType.UnconnectedData, data: cipData },
                  ]);
                  const payload = new Uint8Array(6 + cpfData.length);
                  const view = new DataView(payload.buffer);
                  view.setUint32(0, 0, true);
                  view.setUint16(4, 0, true);
                  payload.set(cpfData, 6);

                  const request = buildEncapsulationPacket(
                    EncapsulationCommand.SendRRData,
                    sessionHandle,
                    new Uint8Array(8),
                    payload,
                  );
                  _socket.write(request);
                } else {
                  clearTimeout(timeout);
                  resolve(new Uint8Array(data));
                }
              } else if (state === "sending") {
                responseData = new Uint8Array(data);
                state = "done";
                clearTimeout(timeout);
                resolve(responseData);
              }
            },
            close() {
              if (state !== "done") {
                clearTimeout(timeout);
                resolve(responseData);
              }
            },
            error(_socket, error) {
              clearTimeout(timeout);
              reject(error);
            },
            open(socket) {
              // Send RegisterSession first
              const protocolData = new Uint8Array(4);
              const view = new DataView(protocolData.buffer);
              view.setUint16(0, 0x0100, true);
              view.setUint16(2, 0, true);
              const request = buildEncapsulationPacket(
                EncapsulationCommand.RegisterSession,
                0,
                new Uint8Array(8),
                protocolData,
              );
              socket.write(request);
            },
          },
        });
      });

      const responseHeader = decodeHeader(response);

      expect(responseHeader.status).toBe(EncapsulationStatus.Success);

      // Verify the tag was written
      expect(engine.tags.get("TestDINT")).toBe(12345);
    });

    test("ListIdentity returns device info", async () => {
      const request = buildEncapsulationPacket(
        EncapsulationCommand.ListIdentity,
        0,
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        new Uint8Array(0),
      );

      const response = await connectAndExchange(server.url, request);
      const header = decodeHeader(response);

      expect(header.command).toBe(EncapsulationCommand.ListIdentity);
      expect(header.status).toBe(EncapsulationStatus.Success);
      expect(header.length).toBeGreaterThan(0);
    });

    test("invalid session handle returns error", async () => {
      // Try SendRRData with invalid session
      const payload = new Uint8Array(6);
      const request = buildEncapsulationPacket(
        EncapsulationCommand.SendRRData,
        0xdeadbeef,
        new Uint8Array(8),
        payload,
      );

      const response = await connectAndExchange(server.url, request);
      const header = decodeHeader(response);

      expect(header.status).toBe(EncapsulationStatus.InvalidSessionHandle);
    });
  });
});

// Helper functions for tests

function buildEncapsulationPacket(
  command: number,
  sessionHandle: number,
  senderContext: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(ENCAP_HEADER_SIZE);
  const view = new DataView(header.buffer);

  view.setUint16(0, command, true);
  view.setUint16(2, data.length, true);
  view.setUint32(4, sessionHandle, true);
  view.setUint32(8, 0, true); // status
  header.set(senderContext, 12);
  view.setUint32(20, 0, true); // options

  if (data.length === 0) {
    return header;
  }

  const packet = new Uint8Array(header.length + data.length);
  packet.set(header);
  packet.set(data, header.length);
  return packet;
}

interface TestSocket {
  end(): void;
  write(data: Uint8Array): void;
}

async function connectAndExchange(url: string, requestData: Uint8Array): Promise<Uint8Array> {
  const match = url.match(/eip:\/\/([^:]+):(\d+)/);
  if (!match) throw new Error(`Invalid URL: ${url}`);

  const hostname = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1];
  const port = parseInt(match[2], 10);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);
    let responseData = new Uint8Array();
    let socketRef: { end: () => void } | null = null;

    Bun.connect({
      hostname,
      port,
      socket: {
        data(_socket, data) {
          responseData = new Uint8Array(data);
          // Close after receiving data
          if (socketRef) {
            socketRef.end();
          }
        },
        close() {
          clearTimeout(timeout);
          resolve(responseData);
        },
        error(_socket, error) {
          clearTimeout(timeout);
          reject(error);
        },
        open(socket) {
          socketRef = socket;
          socket.write(requestData);
          // Give server time to respond before closing
          setTimeout(() => socket.end(), 100);
        },
      },
    });
  });
}

async function registerSessionAndGetHandle(url: string): Promise<number> {
  const protocolData = new Uint8Array(4);
  const view = new DataView(protocolData.buffer);
  view.setUint16(0, 0x0100, true);
  view.setUint16(2, 0, true);

  const request = buildEncapsulationPacket(
    EncapsulationCommand.RegisterSession,
    0,
    new Uint8Array(8),
    protocolData,
  );

  const response = await connectAndExchange(url, request);
  const header = decodeHeader(response);

  if (header.status !== EncapsulationStatus.Success) {
    throw new Error(`RegisterSession failed: 0x${header.status.toString(16)}`);
  }

  return header.sessionHandle;
}
