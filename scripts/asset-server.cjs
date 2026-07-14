// AI Hub 美術產圖工具用的本地小伺服器(零相依,只用 Node 內建模組)。
// 跟 Vite 的 dev server 是分開的兩件事:這支只負責 (1) 把 tools/ai-hub/index.html 端出來,
// (2) 接 AI Hub 的「存入遊戲」請求,把產好的圖寫進 public/assets/<分類>/<檔名>——
// 存進 public/ 之後,不用重開 Vite,npm run dev 那邊重新整理就看得到最新的圖。
// 用法:npm run assets(或 node scripts/asset-server.cjs),然後瀏覽器開 http://localhost:8787
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
const ROOT = path.join(__dirname, '..');
const AI_HUB_DIR = path.join(ROOT, 'tools', 'ai-hub');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

// 只收白名單資料夾 + 嚴格檔名,避免被當成任意寫檔的後門(雖然只聽 127.0.0.1,仍防萬一)
const SAVE_DIRS = new Set(['towers', 'monsters', 'tiles']);
function saveAsset(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 15e6) req.destroy(); }); // 15MB 上限,擋異常請求
  req.on('end', () => {
    const json = (h) => { res.writeHead(h, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); };
    try {
      const { dir, name, b64, overwrite } = JSON.parse(body);
      if (!SAVE_DIRS.has(dir)) { json(400); res.end(JSON.stringify({ error: '不允許的資料夾: ' + dir })); return; }
      if (!/^[a-z0-9\-_]+\.png$/i.test(name || '')) { json(400); res.end(JSON.stringify({ error: '檔名只能是英數-_.png: ' + name })); return; }
      const folder = path.join(PUBLIC_DIR, 'assets', dir);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, name);
      if (fs.existsSync(file) && !overwrite) { json(409); res.end(JSON.stringify({ exists: true })); return; }
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      const rel = 'assets/' + dir + '/' + name;
      console.log('💾 已儲存 public/' + rel);
      json(200); res.end(JSON.stringify({ ok: true, path: rel }));
    } catch (e) { json(500); res.end(JSON.stringify({ error: e.message })); }
  });
}

function serveStatic(res, root, urlPath) {
  const file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found: ' + urlPath); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/save-asset') { saveAsset(req, res); return; }

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // /assets/... 存在的圖片存在 public/ 底下(給批次補齊功能檢查「檔案在不在」用),其餘都是 AI Hub 工具本身
  if (urlPath.startsWith('/assets/')) {
    serveStatic(res, PUBLIC_DIR, urlPath);
  } else {
    serveStatic(res, AI_HUB_DIR, urlPath);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`伺服器已在執行中(port ${PORT}),直接開 http://localhost:${PORT} 即可`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ AI Hub 美術工具伺服器啟動:http://localhost:${PORT}`);
  console.log('   關閉這個視窗即可停止伺服器(這跟 npm run dev 的 Vite 伺服器是分開的)');
});
