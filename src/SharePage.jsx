import { useEffect, useMemo, useRef, useState } from 'react';
import { parseShareText } from './lib/share.js';
import { decryptFileWithDek } from './lib/crypto.js';
import { mapLimit, Semaphore } from './lib/concurrency.js';
import { pickupDecrypt } from './lib/pickup.js';

// 取件箱 Worker 地址（CF Pages 构建环境变量可覆盖）
const PICKUP_BASE = import.meta.env?.VITE_PICKUPBOX_URL || 'https://pickupbox.ybmqldc.workers.dev';

const AUTO_PREVIEW_LIMIT = 100 * 1024 * 1024; // 瀑布流自动加载上限 100MB
// 并发解密线程数：写死 2（访问者是第三方，固定低并发防风控/内存峰值）
const CONCURRENCY = 2;
const decryptSemaphore = new Semaphore(CONCURRENCY);
const PAGE_SIZE = 20; // 媒体每页张数（固定高度网格 + 翻页，杜绝滚动布局抖动）
const MAX_MEDIA_CACHE = 40; // 最多缓存多少个解密后的媒体 Blob（LRU 淘汰防内存爆）

function formatSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function mimeFromName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  };
  return map[ext] || 'application/octet-stream';
}

function isPreviewable(name) {
  const m = mimeFromName(name);
  return m.startsWith('image/') || m.startsWith('video/');
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e) => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

export default function SharePage() {
  const [text, setText] = useState('');
  const [items, setItems] = useState([]); // 解析出的全部条目 { dl, dek, plainName, size }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null); // { name, url, mime }
  const [viewMode, setViewMode] = useState('waterfall'); // waterfall | list
  const [page, setPage] = useState(1); // 媒体网格分页
  const isMobile = useIsMobile();

  // 瀑布流懒加载：Map(index → { url, mime } | { tooBig } | { error })
  const loadedRef = useRef(new Map());
  const [loaded, setLoaded] = useState(new Map());
  const listRef = useRef(null);

  const mediaItems = useMemo(() => items.filter((it) => isPreviewable(it.plainName)), [items]);
  const otherItems = useMemo(() => items.filter((it) => !isPreviewable(it.plainName)), [items]);

  // 媒体分页：每页 PAGE_SIZE 张
  const totalPages = Math.max(1, Math.ceil(mediaItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedItems = useMemo(
    () => mediaItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [mediaItems, safePage],
  );

  /** 解析列表：.key 条目（回传 key）自动拉取解密并展开为资料包；其余原样保留 */
  async function resolveItems(list) {
    const out = [];
    for (const it of list) {
      if (it.plainName && it.plainName.endsWith('.key')) {
        try {
          const plain = await fetchPlain(it);
          const text = new TextDecoder().decode(plain);
          out.push(...parseShareText(text));
        } catch {
          out.push(it); // 展开失败保留原条目（预览时提示）
        }
      } else {
        out.push(it);
      }
    }
    return out;
  }

  async function handleParse() {
    setError('');
    setBusy(true);
    try {
      const list = parseShareText(text);
      setItems(await resolveItems(list));
      loadedRef.current.clear();
      setLoaded(new Map());
    } catch (e) {
      // 不是分享串 → 尝试按「资料编号」（取件码）从取件箱取件
      try {
        const code = text.trim();
        if (!code) throw new Error('请输入资料编号');
        const res = await fetch(`${PICKUP_BASE}/?code=${encodeURIComponent(code)}`);
        if (!res.ok) throw new Error(`取件失败（${res.status}）：编号不存在或已过期`);
        const { data } = await res.json();
        const shareText = await pickupDecrypt(code, data);
        const list = parseShareText(shareText);
        setItems(await resolveItems(list));
        loadedRef.current.clear();
        setLoaded(new Map());
      } catch (e2) {
        setError(e2.message || '解析失败');
        setItems([]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleKeyFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const content = await file.text();
      setText(content.trim());
      setItems(await resolveItems(parseShareText(content)));
      loadedRef.current.clear();
      setLoaded(new Map());
    } catch (err) {
      setError(err.message || 'key 文件解析失败');
      setItems([]);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  /** 拉密文并解密（分享串内封 OneDrive 直链，直连微软 CDN；CORS 受限时回退 CF /api/share/dl 代理） */
  async function fetchPlain(item) {
    if (!item.dl) throw new Error('分享串缺少直链（可能已过期或无效）');
    let cipherRes;
    try {
      cipherRes = await fetch(item.dl); // 直连微软 CDN（1h 直链）
    } catch {
      cipherRes = await fetch(`/api/share/dl?u=${encodeURIComponent(item.dl)}`); // CORS 受限 → CF Pages 代理
    }
    if (!cipherRes.ok) throw new Error(`下载密文失败 HTTP ${cipherRes.status}`);
    const cipher = new Uint8Array(await cipherRes.arrayBuffer());
    return decryptFileWithDek(cipher, item.dek);
  }

  // 媒体卡片：整页加载（信号量限并发），已加载缓存保留（回翻秒显不闪烁），LRU 淘汰防内存爆
  async function loadMediaCard(item, index) {
    if (loadedRef.current.has(index)) return;
    loadedRef.current.set(index, { loading: true, lastUsed: Date.now() });
    setLoaded(new Map(loadedRef.current));
    if (item.size > AUTO_PREVIEW_LIMIT) {
      loadedRef.current.set(index, { tooBig: true, lastUsed: Date.now() });
      setLoaded(new Map(loadedRef.current));
      return;
    }
    try {
      // 解密受信号量限制（最多 CONCURRENCY 个并发），防止同时拉取大量文件
      await decryptSemaphore.acquire();
      let plain;
      try {
        plain = await fetchPlain(item);
      } finally {
        decryptSemaphore.release();
      }
      const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(item.plainName) }));
      loadedRef.current.set(index, { url, mime: mimeFromName(item.plainName), lastUsed: Date.now() });
      setLoaded(new Map(loadedRef.current));
      evictMediaCache();
    } catch (e) {
      loadedRef.current.set(index, { error: e.message || '加载失败', lastUsed: Date.now() });
      setLoaded(new Map(loadedRef.current));
    }
  }

  /** LRU 淘汰：超过 MAX_MEDIA_CACHE 时释放最久未用的 Blob */
  function evictMediaCache() {
    const entries = [...loadedRef.current.entries()];
    if (entries.length <= MAX_MEDIA_CACHE) return;
    entries
      .filter(([, v]) => v.url)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, entries.length - MAX_MEDIA_CACHE)
      .forEach(([idx, v]) => {
        URL.revokeObjectURL(v.url);
        loadedRef.current.delete(idx);
      });
    setLoaded(new Map(loadedRef.current));
  }

  // 分页整页加载：当前页媒体全部进队列（信号量 2 并发）；固定高度网格无滚动抖动
  useEffect(() => {
    if (!mediaItems.length) return;
    const start = (safePage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, mediaItems.length);
    for (let i = start; i < end; i += 1) {
      loadMediaCard(mediaItems[i], i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaItems, safePage]);

  async function handlePreview(item) {
    setBusy(true);
    setError('');
    try {
      const plain = await fetchPlain(item);
      const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(item.plainName) }));
      setPreview({ name: item.plainName, url, mime: mimeFromName(item.plainName) });
    } catch (e) {
      setError(e.message || '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(item) {
    setBusy(true);
    setError('');
    try {
      const plain = await fetchPlain(item);
      const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(item.plainName) }));
      const a = document.createElement('a');
      a.href = url;
      a.download = item.plainName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError(e.message || '下载失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadAll() {
    setBusy(true);
    setError('');
    try {
      // 限流并发下载（防风控，默认 2 线程）
      await mapLimit(items, CONCURRENCY, async (it) => {
        const plain = await fetchPlain(it);
        const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(it.plainName) }));
        const a = document.createElement('a');
        a.href = url;
        a.download = it.plainName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
    } catch (e) {
      setError(e.message || '批量下载中断');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui' }}>
      <h2 style={{ marginBottom: 4 }}>学习资料获取</h2>
      <p style={{ color: '#888', fontSize: 13, marginTop: 0 }}>
        请输入资料编号，验证后获取学习资料；解密在浏览器本地完成。
        <br />资料编号有效期为 <b>6 小时</b>，过期后请联系发布者重新获取。
      </p>

      <textarea
        className="input"
        rows={4}
        placeholder="输入资料编号…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={handleParse} disabled={busy}>
          {busy ? '获取中…' : '获取'}
        </button>
        <label className="btn-ghost" style={{ cursor: 'pointer' }}>
          上传 key 文件
          <input type="file" accept=".key" hidden onChange={handleKeyFile} />
        </label>
        {items.length > 1 && (
          <button className="btn-ghost" onClick={handleDownloadAll} disabled={busy}>
            全部下载（{items.length}）
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          className={viewMode === 'waterfall' ? 'btn-primary' : 'btn-ghost'}
          style={{ padding: '4px 10px' }}
          onClick={() => setViewMode('waterfall')}
        >
          瀑布流
        </button>
        <button
          className={viewMode === 'list' ? 'btn-primary' : 'btn-ghost'}
          style={{ padding: '4px 10px' }}
          onClick={() => setViewMode('list')}
        >
          列表
        </button>
      </div>

      {error && <div style={{ background: '#fdecec', color: '#c33', padding: 10, borderRadius: 8, marginTop: 12 }}>{error}</div>}

      {items.length > 0 && viewMode === 'waterfall' && (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: '#999', fontSize: 13, marginBottom: 8 }}>
            网格预览：每页 {PAGE_SIZE} 张 · 共 {mediaItems.length} 张（第 {safePage}/{totalPages} 页，已加载缓存可回翻秒显）
          </div>
          {mediaItems.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>（无媒体文件）</div>}
          {mediaItems.length > 0 && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 3}, 1fr)`, gap: 12 }}>
                {pagedItems.map((it, i) => {
                  const idx = (safePage - 1) * PAGE_SIZE + i;
                  const m = loaded.get(idx);
                  return (
                    <div
                      key={idx}
                      className="masonry-card"
                      style={{ height: 200, position: 'relative', overflow: 'hidden', borderRadius: 8, cursor: 'pointer', background: '#f2f3f5' }}
                      onClick={() => handlePreview(it)}
                      title={it.plainName}
                    >
                      {m?.url ? (
                        m.mime.startsWith('video/') ? (
                          <video
                            src={m.url}
                            muted
                            playsInline
                            preload="metadata"
                            onLoadedMetadata={(e) => { try { e.currentTarget.currentTime = 0.01; } catch {} }}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        ) : (
                          <img src={m.url} alt={it.plainName} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        )
                      ) : m?.tooBig ? (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 12 }}>过大（&gt;{formatSize(AUTO_PREVIEW_LIMIT)}）</div>
                      ) : m?.error ? (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c33', fontSize: 12 }}>加载失败</div>
                      ) : (
                        <div className="placeholder-pulse" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 12 }}>加载中…</div>
                      )}
                      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '4px 6px', fontSize: 11, color: '#fff', background: 'rgba(0,0,0,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.plainName}</div>
                    </div>
                  );
                })}
              </div>
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, margin: '16px 0' }}>
                  <button className="btn-ghost" style={{ padding: '6px 16px' }} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ 上一页</button>
                  <span style={{ fontSize: 13, color: '#666' }}>第 {safePage} / {totalPages} 页</span>
                  <button className="btn-ghost" style={{ padding: '6px 16px' }} disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>下一页 ›</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {viewMode === 'list' && items.length > 0 && (
        <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, overflow: 'hidden' }}>
          {items.map((it, i) => (
            <div key={`l${i}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid #f3f3f3', fontSize: 14 }}>
              <span
                style={{ flex: 1, wordBreak: 'break-all', cursor: isPreviewable(it.plainName) ? 'pointer' : 'default' }}
                onClick={() => isPreviewable(it.plainName) && handlePreview(it)}
              >
                {isPreviewable(it.plainName)
                  ? (mimeFromName(it.plainName).startsWith('video/') ? '🎬' : '🖼️')
                  : '📄'} {it.plainName}
              </span>
              <span style={{ color: '#999', fontSize: 13 }}>{formatSize(it.size)}</span>
              {isPreviewable(it.plainName) && (
                <button className="btn-link" onClick={() => handlePreview(it)} disabled={busy}>预览</button>
              )}
              <button className="btn-link" onClick={() => handleDownload(it)} disabled={busy}>下载</button>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && viewMode === 'waterfall' && otherItems.length > 0 && (
        <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 12, overflow: 'hidden' }}>
          {otherItems.map((it, i) => (
            <div key={`o${i}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid #f3f3f3', fontSize: 14 }}>
              <span style={{ flex: 1, wordBreak: 'break-all' }}>📄 {it.plainName}</span>
              <span style={{ color: '#999', fontSize: 13 }}>{formatSize(it.size)}</span>
              <button className="btn-link" onClick={() => handleDownload(it)} disabled={busy}>下载</button>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="modal-mask" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>
          <div
            className="modal-card"
            style={{ padding: 16, maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong>{preview.name}</strong>
              <button className="btn-link" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>关闭</button>
            </div>
            {preview.mime.startsWith('video/') ? (
              <video
                src={preview.url}
                controls
                autoPlay
                playsInline
                onLoadedMetadata={(e) => { try { e.currentTarget.currentTime = 0.01; } catch {} }}
                style={{ maxWidth: '85vw', maxHeight: '75vh', objectFit: 'contain' }}
              />
            ) : (
              <img src={preview.url} alt={preview.name} style={{ maxWidth: '85vw', maxHeight: '75vh', objectFit: 'contain' }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
