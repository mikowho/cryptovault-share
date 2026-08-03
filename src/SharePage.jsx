import { useEffect, useMemo, useRef, useState } from 'react';
import { parseShareText } from './lib/share.js';
import { decryptFileWithDek } from './lib/crypto.js';

const AUTO_PREVIEW_LIMIT = 100 * 1024 * 1024; // 瀑布流自动加载上限 100MB

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
  const isMobile = useIsMobile();

  // 瀑布流懒加载：Map(index → { url, mime } | { tooBig } | { error })
  const loadedRef = useRef(new Map());
  const [loaded, setLoaded] = useState(new Map());
  const listRef = useRef(null);

  const mediaItems = useMemo(() => items.filter((it) => isPreviewable(it.plainName)), [items]);
  const otherItems = useMemo(() => items.filter((it) => !isPreviewable(it.plainName)), [items]);

  function handleParse() {
    setError('');
    try {
      setItems(parseShareText(text));
      loadedRef.current.clear();
      setLoaded(new Map());
    } catch (e) {
      setError(e.message || '解析失败');
      setItems([]);
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
      setItems(parseShareText(content));
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

  // 瀑布流：视口附近懒加载解密，离开释放
  async function loadMediaCard(item, index) {
    if (loadedRef.current.has(index)) return;
    loadedRef.current.set(index, { loading: true });
    setLoaded(new Map(loadedRef.current));
    if (item.size > AUTO_PREVIEW_LIMIT) {
      loadedRef.current.set(index, { tooBig: true });
      setLoaded(new Map(loadedRef.current));
      return;
    }
    try {
      const plain = await fetchPlain(item);
      const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(item.plainName) }));
      if (!loadedRef.current.has(index)) {
        URL.revokeObjectURL(url);
        return;
      }
      loadedRef.current.set(index, { url, mime: mimeFromName(item.plainName) });
      setLoaded(new Map(loadedRef.current));
    } catch (e) {
      loadedRef.current.set(index, { error: e.message || '加载失败' });
      setLoaded(new Map(loadedRef.current));
    }
  }

  function releaseMediaCard(index) {
    const entry = loadedRef.current.get(index);
    if (entry?.url) URL.revokeObjectURL(entry.url);
    loadedRef.current.delete(index);
    setLoaded(new Map(loadedRef.current));
  }

  useEffect(() => {
    if (!mediaItems.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number(e.target.dataset.index);
          const item = mediaItems[idx];
          if (!item) continue;
          if (e.isIntersecting) loadMediaCard(item, idx);
          else releaseMediaCard(idx);
        }
      },
      { rootMargin: '400px 0px' },
    );
    const els = listRef.current?.querySelectorAll('[data-media-card]');
    els?.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaItems]);

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
      for (const it of items) {
        const plain = await fetchPlain(it);
        const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(it.plainName) }));
        const a = document.createElement('a');
        a.href = url;
        a.download = it.plainName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e) {
      setError(e.message || '批量下载中断');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui' }}>
      <h2 style={{ marginBottom: 4 }}>解密分享</h2>
      <p style={{ color: '#888', fontSize: 13, marginTop: 0 }}>
        粘贴分享串，或上传 .key 文件；解密在浏览器本地完成，密钥不会上传。
        <br />分享串内的直链约 <b>1 小时</b>有效，过期后需重新生成分享。
      </p>

      <textarea
        className="input"
        rows={4}
        placeholder="粘贴分享串 / key 文件内容…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={handleParse} disabled={busy}>
          解析
        </button>
        <label className="btn-ghost" style={{ cursor: 'pointer' }}>
          上传 .key 文件
          <input type="file" accept=".key" hidden onChange={handleKeyFile} />
        </label>
        {items.length > 1 && (
          <button className="btn-ghost" onClick={handleDownloadAll} disabled={busy}>
            全部下载（{items.length}）
          </button>
        )}
      </div>

      {error && <div style={{ background: '#fdecec', color: '#c33', padding: 10, borderRadius: 8, marginTop: 12 }}>{error}</div>}

      {mediaItems.length > 0 && (
        <div ref={listRef} style={{ marginTop: 16 }}>
          <div style={{ color: '#999', fontSize: 13, marginBottom: 8 }}>
            瀑布流：滚动自动加载视口附近的图片/视频（{mediaItems.length} 个媒体文件）
          </div>
          <div style={{ columnCount: isMobile ? 2 : 3, columnGap: 12 }}>
            {mediaItems.map((it, i) => {
              const m = loaded.get(i);
              return (
                <div
                  key={i}
                  className="masonry-card"
                  style={{ breakInside: 'avoid', marginBottom: 12, cursor: 'pointer' }}
                  data-media-card
                  data-index={i}
                  onClick={() => handlePreview(it)}
                  title={it.plainName}
                >
                  <div style={{ background: '#f2f3f5', borderRadius: 8, overflow: 'hidden' }}>
                    {m?.url ? (
                      m.mime.startsWith('video/') ? (
                        <video src={m.url} muted playsInline preload="metadata" style={{ width: '100%', display: 'block' }} onClick={(e) => e.stopPropagation()} />
                      ) : (
                        <img src={m.url} alt={it.plainName} loading="lazy" style={{ width: '100%', display: 'block' }} />
                      )
                    ) : m?.tooBig ? (
                      <div style={{ padding: 16, color: '#999', fontSize: 12 }}>过大（&gt;{formatSize(AUTO_PREVIEW_LIMIT)}）</div>
                    ) : m?.error ? (
                      <div style={{ padding: 16, color: '#c33', fontSize: 12 }}>加载失败</div>
                    ) : (
                      <div className="placeholder-pulse" style={{ padding: 32, textAlign: 'center', color: '#bbb', fontSize: 12 }}>加载中…</div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#666', padding: '4px 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.plainName}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {otherItems.length > 0 && (
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
              <video src={preview.url} controls autoPlay style={{ maxWidth: '85vw', maxHeight: '75vh', objectFit: 'contain' }} />
            ) : (
              <img src={preview.url} alt={preview.name} style={{ maxWidth: '85vw', maxHeight: '75vh', objectFit: 'contain' }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
