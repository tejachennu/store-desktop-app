/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp + random. Generated on the client for
 * every record so ids are unique while offline and sort by creation time.
 */
let lastMs = 0;
let seq = 0;

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function uuidv7(now: number = Date.now()): string {
  // Monotonic within the same millisecond: bump a 12-bit counter stored in rand_a.
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
  } else {
    lastMs = now;
    seq = randomBytes(2)[0] & 0x7f; // leave headroom for increments
  }
  const b = randomBytes(16);
  const ms = BigInt(now);
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
