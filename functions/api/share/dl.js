/**
 * Cloudflare Pages Functions：代理微软 downloadUrl（分享页 CORS 兜底）。
 * 仅当浏览器直连微软 CDN 被 CORS 拦截时使用（部署后 /share 页会提示）。
 * 流量路径：CF 边缘 → 微软 CDN（不经过你的主站，主站零带宽）。
 * 安全性：只允许代理微软域名，且密文无密钥不可解。
 */
const ALLOWED_HOSTS = [
  /(^|\.)sharepoint\.com$/i,
  /(^|\.)sharepoint\.cn$/i,
  /(^|\.)1drv\.ms$/i,
  /(^|\.)officeapps\.live\.com$/i,
];

export async function onRequest(context) {
  const u = new URL(context.request.url).searchParams.get('u');
  if (!u) {
    return new Response(JSON.stringify({ error: 'u required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  let target;
  try {
    target = new URL(u);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid url' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
    return new Response(JSON.stringify({ error: 'forbidden host' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const upstream = await fetch(target, { method: 'GET', headers: { Accept: context.request.headers.get('Accept') || '*/*' } });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}
