// 一次性批次腳本:呼叫免金鑰的 Pollinations 圖片 API,產生塔「升級分岐路線」後的強化造型,
// 存進 public/assets/towers/<element>-<path>.png(path 是 'burst' 或 'splash',對照
// src/sim/towers.ts 的 UpgradePath、src/game/GameScene.ts 的 towerTextureKeyFor())。
//
// 跟 scripts/generate-tower-monster-assets.mjs 是同一套去背管線(呼叫 Pollinations 拿 JPEG、
// jpeg-js 解碼、邊框 flood fill 去背、pngjs 存成透明背景 PNG),這裡只是換一批 prompt——
// 每個屬性各配 2 種「升級後的強化造型」:
// - burst(單體強化路線):造型變得更尖銳、更有攻擊性,加一根發光尖刺/利刃,呼應「打一個目標
//   但傷害更高」的技能感覺
// - splash(範圍擴散路線):造型變得更寬、加一圈發光光環/擴散元素,呼應「攻擊會波及周圍」的
//   技能感覺
// 未升級前(1~2 級)沿用原本的 <element>.png,不用重產。
//
// 用法:node scripts/generate-tower-evolution-assets.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import pngjsPkg from 'pngjs';

const { PNG } = pngjsPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');

const TOWER_STYLE =
  'Cute chibi cartoon tower defense game asset in the visual spirit of Kingdom Rush, chunky rounded proportions, thick clean outlines, warm saturated colors, soft painterly cel-shaded rendering, whimsical and friendly (not scary), true top-down 90-degree overhead view, single centered structure, bold clean readable silhouette, standing alone on a flat solid white background, no ground, no scenery, no shadow, no text, no watermark, simple game-ready art';

const TOWER_SIZE = 256;
const BACKGROUND_TOLERANCE = 38;

// 每個屬性的 burst/splash 造型,都是在原本塔的基礎上加「升級感」的視覺線索:
// burst 加尖刺/利刃(單體高傷害的攻擊性),splash 加光環/擴散元素(範圍波及的擴散感)。
const EVOLUTION_ASSETS = [
  {
    element: 'metal',
    burst: { seed: 2101, prompt: 'cute chunky golden metal tower upgraded with a tall sharp glowing blade spike on top and ornate armor plating, more imposing and powerful, intense golden glow' },
    splash: { seed: 2102, prompt: 'cute chunky golden metal tower upgraded with wide radiating golden rings and rotating gear halos around it, more imposing and powerful' },
  },
  {
    element: 'wood',
    burst: { seed: 2103, prompt: 'cute chunky wooden watchtower upgraded with a tall sharp thorny spike on top and glowing green rune markings, more imposing and powerful' },
    splash: { seed: 2104, prompt: 'cute chunky wooden watchtower upgraded with wide spreading vine tendrils and glowing green leaf halos radiating outward, more imposing and powerful' },
  },
  {
    element: 'water',
    burst: { seed: 2105, prompt: 'cute chunky deep-blue crystal tower upgraded with a tall sharp glowing ice spike on top, more imposing and powerful, intense blue glow' },
    splash: { seed: 2106, prompt: 'cute chunky deep-blue crystal tower upgraded with wide rippling water ring halos radiating outward, more imposing and powerful' },
  },
  {
    element: 'fire',
    burst: { seed: 2107, prompt: 'cute chunky orange stone tower upgraded with a tall roaring flame spike on top, more imposing and powerful, intense orange glow' },
    splash: { seed: 2108, prompt: 'cute chunky orange stone tower upgraded with wide radiating fire ring halos and floating embers around it, more imposing and powerful' },
  },
  {
    element: 'earth',
    burst: { seed: 2109, prompt: 'cute chunky brown stone tower upgraded with a tall sharp crystal spike on top and glowing rune carvings, more imposing and powerful' },
    splash: { seed: 2110, prompt: 'cute chunky brown stone tower upgraded with wide radiating earthen ring halos and floating rock fragments around it, more imposing and powerful' },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJpeg(prompt, size, seed) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${size}&height=${size}&seed=${seed}&nologo=true`;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const backoffMs = attempt * 8000;
    console.warn(`  HTTP ${res.status},第 ${attempt}/${maxAttempts} 次,等 ${backoffMs / 1000}s 後重試`);
    await sleep(backoffMs);
  }
  throw new Error(`重試 ${maxAttempts} 次後仍失敗`);
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function floodFillTransparentBackground(data, width, height, tolerance) {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = [];

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let borderCount = 0;
  const pushBorder = (x, y) => {
    const pos = y * width + x;
    queue.push(pos);
    const idx = pos * 4;
    rSum += data[idx];
    gSum += data[idx + 1];
    bSum += data[idx + 2];
    borderCount++;
  };
  for (let x = 0; x < width; x++) {
    pushBorder(x, 0);
    pushBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    pushBorder(0, y);
    pushBorder(width - 1, y);
  }

  const refR = rSum / borderCount;
  const refG = gSum / borderCount;
  const refB = bSum / borderCount;

  let qi = 0;
  let removed = 0;
  while (qi < queue.length) {
    const pos = queue[qi++];
    if (visited[pos]) continue;
    const idx = pos * 4;
    if (colorDistance(data[idx], data[idx + 1], data[idx + 2], refR, refG, refB) > tolerance) continue;
    visited[pos] = 1;
    data[idx + 3] = 0;
    removed++;
    const x = pos % width;
    const y = (pos / width) | 0;
    if (x > 0) queue.push(pos - 1);
    if (x < width - 1) queue.push(pos + 1);
    if (y > 0) queue.push(pos - width);
    if (y < height - 1) queue.push(pos + width);
  }
  return removed / total;
}

async function generateOne(element, pathName, spec) {
  const label = `towers/${element}-${pathName}.png`;
  console.log(`產生中: ${label} ...`);
  const jpegBuf = await fetchJpeg(`${spec.prompt}, ${TOWER_STYLE}`, TOWER_SIZE, spec.seed);
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const removedRatio = floodFillTransparentBackground(decoded.data, decoded.width, decoded.height, BACKGROUND_TOLERANCE);
  const pngBuffer = PNG.sync.write({ width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) });

  const outDir = path.join(PUBLIC_ASSETS_DIR, 'towers');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${element}-${pathName}.png`), pngBuffer);
  console.log(`✅ ${label}(去背比例 ${(removedRatio * 100).toFixed(1)}%)`);
}

async function main() {
  for (const asset of EVOLUTION_ASSETS) {
    for (const pathName of ['burst', 'splash']) {
      try {
        await generateOne(asset.element, pathName, asset[pathName]);
      } catch (err) {
        console.error(`❌ towers/${asset.element}-${pathName}: ${err.message}`);
      }
      await sleep(6000);
    }
  }
  console.log('完成。去背比例如果明顯偏低(<50%)或偏高(>95%),建議手動檢查那張圖。');
}

main();
