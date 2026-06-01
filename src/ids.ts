const SHORT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MIN_SHORT_ID_LENGTH = 4;

export type ShortIdGenerator = () => string;

export function createShortIdGenerator(): ShortIdGenerator {
  const issuedIds = new Set<string>();
  let length = MIN_SHORT_ID_LENGTH;

  return () => {
    while (issuedIds.size >= idCapacity(length)) {
      length += 1;
    }

    let id = randomBase62Id(length);
    while (issuedIds.has(id)) {
      id = randomBase62Id(length);
    }

    issuedIds.add(id);
    return id.padStart(MIN_SHORT_ID_LENGTH, SHORT_ID_ALPHABET[0]);
  };
}

function randomBase62Id(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let encoded = "";

  for (const byte of bytes) {
    encoded += SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]!;
  }

  return encoded;
}

function idCapacity(length: number): number {
  return SHORT_ID_ALPHABET.length ** length;
}
