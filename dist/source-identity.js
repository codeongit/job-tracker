const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

// Synchronous and dependency-free so the service, static browser and migration
// code use one exact identity algorithm.
export function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(size);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(size - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(size - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries())
      hash[index] = (hash[index] + value) >>> 0;
  }
  return [...hash].map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function bossFactType(event) {
  if (event.eventType === 'resume_observed') return event.summary;
  if (event.receiptStatus === 'read') return 'message_receipt_read';
  if (event.receiptStatus === 'delivered') return 'message_receipt_delivered';
  if (event.messageDirection === 'inbound') return 'message_inbound';
  if (event.messageDirection === 'outbound') return 'message_outbound_observed';
  return 'message_observed';
}

export function hasBossFactIdentity(event) {
  const factType = event?.factType || bossFactType(event || {});
  return [
    event?.platform || 'boss',
    event?.accountNamespace,
    event?.conversationKey,
    event?.messageId,
    factType,
  ].every((value) => typeof value === 'string' && value.trim());
}

function factIdentityKey(event) {
  const factType = event.factType || bossFactType(event);
  if (!hasBossFactIdentity({ ...event, factType }))
    throw new Error('BOSS_FACT_IDENTITY_INCOMPLETE');
  const identity = [
    'boss-fact-v1',
    event.platform || 'boss',
    event.accountNamespace || '',
    event.conversationKey || '',
    event.messageId || '',
    factType,
  ];
  return JSON.stringify(identity);
}

// Reuse a pure calculation only. Every caller still validates its actual record;
// a supplied fact ID is never a cache key or a trusted result.
export function createBossFactIdResolver({ maxEntries = 4096, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0
  )
    throw new Error('BOSS_FACT_CACHE_LIMIT_INVALID');
  const cache = new Map();
  let bytes = 0,
    hits = 0,
    misses = 0,
    evictions = 0;
  return {
    factId(event) {
      const key = factIdentityKey(event);
      const found = cache.get(key);
      if (found) {
        cache.delete(key);
        cache.set(key, found);
        hits++;
        return found.id;
      }
      misses++;
      const id = `boss-fact-${sha256Hex(key)}`;
      // Conservative UTF-16 string storage accounting, independent of input encoding.
      const size = (key.length + id.length) * 2;
      if (maxEntries && size <= maxBytes) {
        while (cache.size >= maxEntries || bytes + size > maxBytes) {
          const oldestKey = cache.keys().next().value;
          bytes -= cache.get(oldestKey).size;
          cache.delete(oldestKey);
          evictions++;
        }
        cache.set(key, { id, size });
        bytes += size;
      }
      return id;
    },
    stats: () => ({ entries: cache.size, bytes, hits, misses, evictions }),
  };
}

const factIdResolver = createBossFactIdResolver();
export const bossFactId = (event) => factIdResolver.factId(event);

export const bossApplicationId = (factId) =>
  `boss-application-${String(factId).replace(/^boss-fact-/, '')}`;
