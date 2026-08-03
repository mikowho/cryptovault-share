# 分享解密页（独立工程，可单独部署 Cloudflare Pages）

本目录是一个**独立的解密页工程**，只包含分享解密功能（粘贴分享串 / 上传 .key 文件 →
浏览器本地解密 → 预览/下载），与主站代码分离，可直接托管到 Cloudflare Pages。

## 目录结构

```
sharepage/
├── src/
│   ├── main.jsx           入口（无路由，直接渲染解密页）
│   ├── SharePage.jsx      解密页 UI
│   ├── index.css          样式
│   └── lib/
│       ├── format.js      文件格式 + 混淆算法（自包含副本）
│       ├── share.js       分享串编解码
│       └── crypto.js      浏览器解密（DEK 解密内容）
└── functions/api/share/
    ├── raw.js             CF Pages Functions：转发"签发直链"请求到主站
    └── dl.js              CF Pages Functions：CORS 受限时的密文代理兜底
```

## 部署到 Cloudflare Pages

1. CF Pages → 创建项目 → 连接 GitHub 仓库
2. 构建设置：
   - **Root directory**: `sharepage`
   - **Build command**: `npm ci && npm run build`
   - **Build output directory**: `dist`
3. 环境变量：`SHARE_UPSTREAM` = 你的主站地址（如 `https://vault.example.com`）
4. 部署后访问 `https://<你的pages域名>/`

## 数据流（302 直链，主站零密文带宽）

```
浏览器 → /api/share/raw (CF Functions) → 主站 → 返回 OneDrive downloadUrl
     └──> 直连微软 CDN 拉密文 → 本地 WebCrypto 解密（用分享串里的文件 DEK）
```

- 主站只签发直链（控制面），密文流量走微软 CDN
- 若微软 downloadUrl 的 CORS 受限，自动回退 `/api/share/dl`（CF 边缘 → 微软）

## 本地开发

```bash
cd sharepage
npm install
npm run dev        # http://localhost:5273，/api/share/raw 代理到本机主站 :3000
```

## 注意

- 主站必须**先授权对应账号**并允许分享（`/api/share/raw` 在主站已实现）
- 本目录的 `lib/` 是主站 `shared/` 与 `frontend/src/lib/` 的**自包含副本**；
  若主站加密格式有变更，需同步更新本目录对应文件
