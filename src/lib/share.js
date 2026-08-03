/**
 * 分享密钥编解码（新方案：分享串内封入 OneDrive 直链 downloadUrl + 文件 DEK）。
 * 对方拿到分享串即可直连微软 CDN 拉密文，不依赖主站在线；注意分享串 1 小时有效（直链时效）。
 * 单文件 = 一段分享串；批量 = .key 文件（混淆 JSON）。
 */
import { obfuscate, deobfuscate, toBase64Url, fromBase64Url } from '../../../shared/format.js';

/** 单文件分享串编码 */
export function encodeShareItem({ dl, dek, plainName, size }) {
  if (!dl) throw new Error('缺少直链（downloadUrl）');
  return obfuscate(
    JSON.stringify({
      dl,
      d: toBase64Url(dek),
      n: plainName,
      s: size || 0,
    }),
  );
}

/** 单文件分享串解码 */
export function decodeShareItem(token) {
  const o = JSON.parse(deobfuscate(String(token).trim()));
  if (!o.dl || !o.d) throw new Error('分享串无效');
  return { dl: o.dl, dek: fromBase64Url(o.d), plainName: o.n || 'file', size: o.s || 0 };
}

/** 批量 .key 文件编码（混淆 JSON） */
export function encodeKeyFile(items) {
  return obfuscate(
    JSON.stringify({
      v: 2,
      items: items.map((it) => ({
        dl: it.dl,
        d: toBase64Url(it.dek),
        n: it.plainName,
        s: it.size || 0,
      })),
    }),
  );
}

/** .key 文件解码 → items[] */
export function decodeKeyFile(text) {
  const o = JSON.parse(deobfuscate(String(text).trim()));
  if (o.v !== 2 || !Array.isArray(o.items)) throw new Error('key 文件无效');
  return o.items.map((it) => ({
    dl: it.dl,
    dek: fromBase64Url(it.d),
    plainName: it.n || 'file',
    size: it.s || 0,
  }));
}

/** 兼容解析：单文件分享串 或 .key 文件内容 */
export function parseShareText(text) {
  const t = String(text).trim();
  try {
    return [decodeShareItem(t)];
  } catch {
    /* 尝试 key 文件 */
  }
  return decodeKeyFile(t);
}
