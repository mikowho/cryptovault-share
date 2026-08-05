/**
 * 取件码加密（存件暗号）：
 *   取件码 → PBKDF2-SHA256(salt='pickupbox-v1', 100000) → AES-256-GCM 密钥
 *   加密内容 = 分享串文本；密文格式 base64url(iv||ct||tag)
 * 加密端（存件）与解密端（取件）共用此实现，参数必须一致。
 */
import { toBase64Url, fromBase64Url } from './format.js';

const PICKUP_SALT = 'pickupbox-v1';
const PICKUP_ITERATIONS = 100_000;
const IV_LENGTH = 12;

/** 取件码规范化：自动补书名号。'进化心理学' → '《进化心理学》'（已带书名号则不变） */
export function normalizePickupCode(raw) {
  const s = (raw || '').trim();
  if (!s) return s;
  let out = s;
  if (!out.startsWith('《')) out = `《${out}`;
  if (!out.endsWith('》')) out = `${out}》`;
  return out;
}

async function pickupKey(code) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(PICKUP_SALT), iterations: PICKUP_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 取件码加密分享串 → base64url(iv||ct||tag) */
export async function pickupEncrypt(code, text) {
  const key = await pickupKey(code);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_LENGTH);
  return toBase64Url(out);
}

/** 取件码解密 → 分享串文本（取件码错误抛错） */
export async function pickupDecrypt(code, b64) {
  const key = await pickupKey(code);
  const raw = fromBase64Url(b64);
  if (raw.length <= IV_LENGTH) throw new Error('取件内容无效');
  const iv = raw.slice(0, IV_LENGTH);
  const ct = raw.slice(IV_LENGTH);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
