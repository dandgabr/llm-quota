import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing for local accounts (ADR-013).
 *
 * Uses Node's built-in async `scrypt` (zero runtime dependencies). Parameters
 * are serialized into a parseable PHC-style string so they can be raised later
 * without invalidating existing hashes (verify parses the stored parameters).
 *
 * scrypt is memory-hard: N=2^16, r=8 => 128*N*r = 64 MiB per derivation. A
 * global semaphore bounds concurrency so a burst of login attempts cannot
 * exhaust memory or starve the libuv threadpool (default 4 threads).
 */

/** Promisified scrypt with the options overload preserved. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolvePromise(derived);
    });
  });
}

export interface ScryptParams {
  /** CPU/memory cost (power of two). */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
}

/** Current parameters for NEW hashes. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 16, r: 8, p: 1 };

/** Explicit maxmem (bytes) for the current params; 128 MiB leaves headroom. */
export const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Upper bound on accepted password length (DoS guard for the KDF). */
export const MAX_PASSWORD_LENGTH = 1024;

/** Minimum accepted password length (NIST 800-63B recommendation). */
export const MIN_PASSWORD_LENGTH = 12;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Global in-process concurrency limit for scrypt derivations. Two concurrent
 * derivations already consume ~128 MiB; keeping it small protects the process.
 */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

const scryptSemaphore = new Semaphore(2);

/** Hash a password into a PHC-style `$scrypt$ln=..,r=..,p=..$salt$hash` string. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(SALT_LENGTH);
  const release = await scryptSemaphore.acquire();
  try {
    const derived = (await scryptAsync(password, salt, KEY_LENGTH, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    })) as Buffer;
    return `$scrypt$ln=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
  } finally {
    release();
  }
}

/** Parse a stored PHC hash; returns null when malformed or unsupported. */
export function parsePasswordHash(
  stored: string,
): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  // "", "scrypt", "ln=..,r=..,p=..", salt, hash
  if (parts.length !== 5 || parts[1] !== "scrypt") return null;
  const [empty, , paramSpec, saltB64, hashB64] = parts;
  void empty;
  if (!paramSpec || !saltB64 || !hashB64) return null;
  const paramMap = new Map<string, number>(
    paramSpec.split(",").map((kv): [string, number] => {
      const [k, v] = kv.split("=");
      return [k ?? "", Number(v)];
    }),
  );
  const N = paramMap.get("ln");
  const r = paramMap.get("r");
  const p = paramMap.get("p");
  if (!N || !r || !p || Number.isNaN(N) || Number.isNaN(r) || Number.isNaN(p)) return null;
  return {
    params: { N, r, p },
    salt: Buffer.from(saltB64, "base64"),
    hash: Buffer.from(hashB64, "base64"),
  };
}

/** Constant-time verification of a password against a stored PHC hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const release = await scryptSemaphore.acquire();
  try {
    const derived = (await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: parsed.params.N,
      r: parsed.params.r,
      p: parsed.params.p,
      maxmem: SCRYPT_MAXMEM,
    })) as Buffer;
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  } finally {
    release();
  }
}

/**
 * Run a dummy verification for unknown/inactive users so the response time
 * does not reveal whether the account exists (anti-enumeration).
 */
export async function dummyVerify(password: string): Promise<void> {
  const salt = Buffer.alloc(SALT_LENGTH, 0);
  const release = await scryptSemaphore.acquire();
  try {
    await scryptAsync(password.slice(0, MAX_PASSWORD_LENGTH), salt, KEY_LENGTH, {
      ...DEFAULT_SCRYPT_PARAMS,
      maxmem: SCRYPT_MAXMEM,
    });
  } finally {
    release();
  }
}

/** True when a plaintext password satisfies the baseline policy. */
export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

function assertPasswordLength(password: string): void {
  if (!isValidPassword(password)) {
    throw new Error(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`);
  }
}
