/**
 * 文件格式 / 密钥派生参数 / 工具函数 —— 前后端共享定义（纯字节级，无加密实现）。
 *
 * 密文文件布局（HEADER_SIZE = 84B 定长头 + 块流）：
 *   [4B magic "CVP1"][1B version][3B reserved]
 *   [12B wrapIV][32B 加密DEK][16B wrapTag]      ← DEK 用 wrapKey(AES-256-GCM) 包裹
 *   [4B chunkSize][12B baseIV]
 *   [块0: chunkSize+16B tag][块1: ...][...]
 *
 * 每块 IV = baseIV 前 8 字节 + 块序号(4B 大端)，全文件唯一且支持随机定位。
 */

export const MAGIC = 'CVP1';
export const FORMAT_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 1 * 1024 * 1024; // 1 MiB
export const DEK_LENGTH = 32;
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;
export const HEADER_SIZE = 8 + 12 + 32 + 16 + 4 + 12; // 84

/** 密钥派生参数（改动后旧数据不兼容，务必谨慎） */
export const KDF_SALT = 'cryptonedrive-kdf-salt-v1';
export const KDF_ITERATIONS = 300_000;
export const HKDF_SALT = 'cryptonedrive-hkdf-salt-v1';
export const INFO_WRAP = 'cryptonedrive-wrap-v1';
export const INFO_NAME = 'cryptonedrive-name-v1';

/** OneDrive 上的加密根目录（固定名，其内部目录/文件名均加密） */
export const VAULT_ROOT = '.crypto';

/** 分享串简单混淆密钥（XOR，防肉眼识别，非强加密——见 PRD §3.5） */
export const SHARE_XOR_KEY = 'cryptonedrive-share-v1';

/** 块 IV = baseIV 前 8 字节 + 块序号（4B 大端），返回 12B Uint8Array */
export function chunkIV(baseIV, chunkIndex) {
  const out = new Uint8Array(IV_LENGTH);
  out.set(baseIV.slice(0, 8), 0);
  out[8] = (chunkIndex >>> 24) & 0xff;
  out[9] = (chunkIndex >>> 16) & 0xff;
  out[10] = (chunkIndex >>> 8) & 0xff;
  out[11] = chunkIndex & 0xff;
  return out;
}

/** 解析文件头；格式非法返回 null */
export function parseHeader(u8) {
  if (!u8 || u8.byteLength < HEADER_SIZE) return null;
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== MAGIC) return null;
  return {
    magic,
    version: u8[4],
    wrapIV: u8.slice(8, 8 + IV_LENGTH),
    encryptedDEK: u8.slice(20, 20 + DEK_LENGTH),
    wrapTag: u8.slice(52, 52 + TAG_LENGTH),
    chunkSize: ((u8[68] << 24) | (u8[69] << 16) | (u8[70] << 8) | u8[71]) >>> 0,
    baseIV: u8.slice(72, 72 + IV_LENGTH),
  };
}

/** 构造文件头（84B Uint8Array） */
export function buildHeader({ wrapIV, encryptedDEK, wrapTag, chunkSize, baseIV }) {
  const u8 = new Uint8Array(HEADER_SIZE);
  u8[0] = MAGIC.charCodeAt(0);
  u8[1] = MAGIC.charCodeAt(1);
  u8[2] = MAGIC.charCodeAt(2);
  u8[3] = MAGIC.charCodeAt(3);
  u8[4] = FORMAT_VERSION;
  u8.set(wrapIV, 8);
  u8.set(encryptedDEK, 20);
  u8.set(wrapTag, 52);
  u8[68] = (chunkSize >>> 24) & 0xff;
  u8[69] = (chunkSize >>> 16) & 0xff;
  u8[70] = (chunkSize >>> 8) & 0xff;
  u8[71] = chunkSize & 0xff;
  u8.set(baseIV, 72);
  return u8;
}

/** 明文长度 → 块数 */
export function chunkCount(plainLength, chunkSize = DEFAULT_CHUNK_SIZE) {
  return plainLength === 0 ? 1 : Math.ceil(plainLength / chunkSize);
}

/** 明文长度 → 密文总长度（按实际每块长度 + 16B tag 计算） */
export function cipherLength(plainLength, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (plainLength <= 0) return HEADER_SIZE + TAG_LENGTH;
  const full = Math.floor(plainLength / chunkSize);
  const rem = plainLength % chunkSize;
  return HEADER_SIZE + full * (chunkSize + TAG_LENGTH) + (rem > 0 ? rem + TAG_LENGTH : 0);
}

/** 拼接多个 Uint8Array */
export function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** base64url 编解码（文件名用） */
export function toBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new Error('密钥格式无效（base64url 校验失败）');
  }
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 分享串混淆：XOR + base64url（可逆，防肉眼识别；不防逆向） */
export function obfuscate(str) {
  const bytes = new TextEncoder().encode(str);
  const key = new TextEncoder().encode(SHARE_XOR_KEY);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ key[i % key.length];
  return toBase64Url(out);
}

/** 分享串反混淆 */
export function deobfuscate(str) {
  const bytes = fromBase64Url(str);
  const key = new TextEncoder().encode(SHARE_XOR_KEY);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ key[i % key.length];
  return new TextDecoder().decode(out);
}
