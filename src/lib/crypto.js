/**
 * 浏览器端加密模块（WebCrypto；Node >= 20 亦可直接运行用于测试）。
 * 密钥体系：
 *   密码 → PBKDF2-SHA256 → KEK(32B)
 *        ├─ HKDF → wrapKey（包裹每文件 DEK）
 *        └─ HKDF → filenameKey（加密文件名/目录名）
 * 登录凭据：SHA-256(KEK) 十六进制（后端只存这个，不持有 KEK/密码）。
 */
import {
  KDF_SALT,
  KDF_ITERATIONS,
  HKDF_SALT,
  INFO_WRAP,
  INFO_NAME,
  DEFAULT_CHUNK_SIZE,
  DEK_LENGTH,
  IV_LENGTH,
  TAG_LENGTH,
  HEADER_SIZE,
  chunkIV,
  parseHeader,
  buildHeader,
  concatBytes,
  toBase64Url,
  fromBase64Url,
} from './format.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 密码 → KEK（Uint8Array 32B） */
export async function deriveKek(password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF_SALT), iterations: KDF_ITERATIONS },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** 登录凭据：KEK 的 SHA-256 hex */
export async function kekHashHex(kek) {
  const digest = await crypto.subtle.digest('SHA-256', kek);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hkdfAesKey(kek, info) {
  const base = await crypto.subtle.importKey('raw', kek, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 从 KEK 派生子密钥（wrapKey 用于包裹 DEK；filenameKey 用于文件名） */
export async function deriveKeys(kek) {
  return {
    wrapKey: await hkdfAesKey(kek, INFO_WRAP),
    filenameKey: await hkdfAesKey(kek, INFO_NAME),
  };
}

/** 文件加密：明文 Uint8Array → 密文 Uint8Array（含文件头） */
export async function encryptFile(plain, kek) {
  const { wrapKey } = await deriveKeys(kek);
  const chunkSize = DEFAULT_CHUNK_SIZE;

  const dek = crypto.getRandomValues(new Uint8Array(DEK_LENGTH));
  const wrapIV = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIV }, wrapKey, dek));
  const encryptedDEK = wrapped.slice(0, DEK_LENGTH);
  const wrapTag = wrapped.slice(DEK_LENGTH);
  const baseIV = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const dekKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['encrypt', 'decrypt']);

  const n = Math.max(1, Math.ceil(plain.length / chunkSize));
  const chunks = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, plain.length);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIV(baseIV, i) }, dekKey, plain.slice(start, end)),
    );
    chunks.push(ct);
  }

  const header = buildHeader({ wrapIV, encryptedDEK, wrapTag, chunkSize, baseIV });
  const total = HEADER_SIZE + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let off = HEADER_SIZE;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 提取文件 DEK（分享用：分享只需 DEK，不泄露主密码派生密钥） */
export async function extractDek(cipher, kek) {
  const header = parseHeader(cipher);
  if (!header) throw new Error('bad cipher format: invalid header');
  if (header.version !== 1) throw new Error(`unsupported format version: ${header.version}`);
  const { wrapKey } = await deriveKeys(kek);
  const dek = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: header.wrapIV },
      wrapKey,
      concatBytes(header.encryptedDEK, header.wrapTag),
    ),
  );
  return { dek, header };
}

/** 用文件 DEK 直接解密内容（分享接收方使用，无需主密码） */
export async function decryptFileWithDek(cipher, dek) {
  const header = parseHeader(cipher);
  if (!header) throw new Error('bad cipher format: invalid header');
  const dekKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['decrypt']);
  const chunkTotal = header.chunkSize + TAG_LENGTH;
  const parts = [];
  let off = HEADER_SIZE;
  let index = 0;
  while (off < cipher.length) {
    const end = Math.min(off + chunkTotal, cipher.length);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIV(header.baseIV, index) }, dekKey, cipher.slice(off, end)),
    );
    parts.push(pt);
    off = end;
    index += 1;
  }
  return concatBytes(...parts);
}

/** 文件解密：密文 Uint8Array → 明文 Uint8Array；密钥错误/数据被篡改会抛错 */
export async function decryptFile(cipher, kek) {
  const { dek } = await extractDek(cipher, kek);
  return decryptFileWithDek(cipher, dek);
}

/** 文件名/目录名加密：明文 → base64url（iv||ct||tag） */
export async function encryptName(name, filenameKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, filenameKey, enc.encode(name)));
  return toBase64Url(concatBytes(iv, ct));
}

/** 文件名/目录名解密 */
export async function decryptName(encoded, filenameKey) {
  const raw = fromBase64Url(encoded);
  const iv = raw.slice(0, IV_LENGTH);
  const ct = raw.slice(IV_LENGTH);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, filenameKey, ct);
  return dec.decode(pt);
}

/**
 * 明文路径 → OneDrive 密文路径（相对 VAULT_ROOT；逐段加密目录名/文件名）。
 * 例：'/照片/2024/a.jpg' → '/照片加密名/2024加密名/a加密名'
 */
export async function encryptPath(plainPath, filenameKey) {
  const segs = plainPath.split('/').filter(Boolean);
  const encrypted = [];
  for (const s of segs) encrypted.push(await encryptName(s, filenameKey));
  return `/${encrypted.join('/')}`;
}

/** OneDrive 密文路径 → 明文路径 */
export async function decryptPath(cipherPath, filenameKey) {
  const segs = cipherPath.split('/').filter(Boolean);
  const plain = [];
  for (const s of segs) plain.push(await decryptName(s, filenameKey));
  return `/${plain.join('/')}`;
}
