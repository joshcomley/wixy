export const CALL_PROTOCOL = "wixy-call-v1";
export const FRAME_SAMPLES = 480;
export const FRAME_BYTES = 1008;
export const LEASE_MS = 300;

export function encodeFrame(callId: string, sequence: number, lease: number, pcm: ArrayBuffer): ArrayBuffer {
  if (!/^[a-f0-9]{32}$/.test(callId) || pcm.byteLength !== 960) throw new Error("Invalid audio frame");
  const packet = new ArrayBuffer(FRAME_BYTES);
  const view = new DataView(packet);
  view.setUint8(0, 1);
  view.setUint8(1, 1);
  for (let i = 0; i < 16; i++) view.setUint8(4 + i, parseInt(callId.slice(i * 2, i * 2 + 2), 16));
  view.setUint32(20, sequence);
  view.setBigUint64(24, BigInt(sequence) * 480n);
  view.setUint32(32, lease);
  new Uint8Array(packet, 48).set(new Uint8Array(pcm));
  return packet;
}

export function decodeFrame(packet: ArrayBuffer): { callId: string; sequence: number; lease: number; pcm: ArrayBuffer } {
  if (packet.byteLength !== FRAME_BYTES) throw new Error("Invalid audio size");
  const view = new DataView(packet);
  if (view.getUint8(0) !== 1 || view.getUint8(1) !== 1 || view.getUint16(2) !== 0
    || view.getBigUint64(40) !== 0n) throw new Error("Invalid audio header");
  const callId = Array.from(new Uint8Array(packet, 4, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return { callId, sequence: view.getUint32(20), lease: view.getUint32(36), pcm: packet.slice(48) };
}
