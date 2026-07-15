// 一次性批次腳本:呼叫免金鑰的 Pollinations 圖片 API,產生塔/怪物的正式美術,存進
// public/assets/towers/、public/assets/monsters/(檔名對照 src/game/GameScene.ts 的
// TOWER_IMAGE_FILES/MONSTER_IMAGE_FILES,tools/ai-hub 的 GAME_ASSETS 清單)。
//
// 跟 scripts/generate-decor-assets.mjs 不同:裝飾物是背景點綴,沒去背也還好;
// 塔/怪物是前景遊戲物件,沒去背會是很明顯的方形色塊,所以這裡一定要做真正的 alpha 透明。
// Pollinations 回傳的是 JPEG(沒有原生透明度),用 jpeg-js 解碼成像素、從四個邊框
// flood fill 挖掉背景色(跟 tools/ai-hub 的去背邏輯同個原理:抓邊框色當背景參考色,
// 顏色夠接近才挖,挖到主體邊界就停,不會把主體本身也挖空),再用 pngjs 存成真正
// 透明背景的 PNG。jpeg-js/pngjs 都是純 JS、沒有原生編譯相依。
//
// 用法:node scripts/generate-tower-monster-assets.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import pngjsPkg from 'pngjs';

const { PNG } = pngjsPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');

// 跟 tools/ai-hub/index.html 的 MASTER/MASTER_CREATURE 模板同個方向(魔獸爭霸風格、
// 單一主體置中),額外要求「純白色平面背景、沒有地面/場景/陰影」——這樣才有一片
// 顏色統一的背景可以讓下面的 flood fill 乾淨地挖掉。
const TOWER_STYLE =
  'Stylized fantasy RTS game building asset in the visual spirit of Warcraft III, true top-down 90-degree overhead view, single centered structure, bold clean readable silhouette, painterly cel-shaded rendering, rich saturated elemental colors, standing alone on a flat solid white background, no ground, no scenery, no shadow, no text, no watermark, simple game-ready art';
const MONSTER_STYLE =
  'Stylized fantasy RTS game creature sprite in the visual spirit of Warcraft III, three-quarter top-down view, full body visible standing pose, single centered creature, bold clean readable silhouette, painterly cel-shaded rendering, rich saturated elemental colors, standing alone on a flat solid white background, no ground, no scenery, no shadow, no text, no watermark, simple game-ready art';

// 五個元素各自的主體描述,取自 tools/ai-hub/index.html 的 GAME_ASSETS 清單(已經調過的
// prompt 措辭),保持跟 AI Hub 手動生圖版本一致的風格。
const TOWER_ASSETS = [
  { element: 'metal', seed: 1101, prompt: 'ornate golden metal spire tower with sharp blade-like finials and polished bronze armor plating, small defensive turret, faint magical shimmer' },
  { element: 'wood', seed: 1102, prompt: 'living wooden watchtower entwined with green vines and glowing leaves, organic bark texture, small defensive turret' },
  { element: 'water', seed: 1103, prompt: 'crystalline deep-blue tower with flowing water motifs and a translucent aqua crystal spire, small defensive turret' },
  { element: 'fire', seed: 1104, prompt: 'volcanic obsidian tower with glowing orange lava cracks and small flame bursts at the top, small defensive turret' },
  { element: 'earth', seed: 1105, prompt: 'sturdy brown stone and clay tower with mossy boulders and earthen rune carvings, small squat defensive turret' },
];
const MONSTER_ASSETS = [
  { element: 'metal', seed: 1201, prompt: 'small mechanical golem creature made of gleaming gold and bronze plates, sharp metallic claws, glowing amber eyes, single creature' },
  { element: 'wood', seed: 1202, prompt: 'small forest treant sprite creature covered in green leaves and vines, bark-like skin, glowing green eyes, single creature' },
  { element: 'water', seed: 1203, prompt: 'small serpentine water elemental creature made of flowing translucent blue water, fin-like limbs, glowing cyan eyes, single creature' },
  { element: 'fire', seed: 1204, prompt: 'small fiery imp creature wreathed in orange flames, charcoal-black skin with glowing cracks, glowing red eyes, single creature' },
  { element: 'earth', seed: 1205, prompt: 'small rocky golem creature made of brown clay and stone chunks with mossy patches, glowing yellow eyes, single creature' },
];

const TOWER_SIZE = 256;
const MONSTER_SIZE = 512;
const BACKGROUND_TOLERANCE = 38; // 顏色距離門檻:JPEG 壓縮會讓「純白背景」有一點雜訊,門檻太低會挖不乾淨

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 免費匿名額度同時間只能有 1 個請求在排隊,打太快會被 429/500 擋掉,
// 所以每張圖之間要等、遇到限流要重試,不能狂送(跟 generate-decor-assets.mjs 同一套做法)。
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

/**
 * 從四個邊框開始 flood fill:邊框像素的平均色當背景參考色,顏色夠接近參考色的
 * 相連像素才挖成透明,碰到跟參考色差太遠的像素(=主體邊界)就停手,不會往內
 * 挖到主體本身。回傳實際挖掉的像素比例,方便事後檢查(太低代表沒挖乾淨,
 * 太高代表可能連主體都被挖空了)。
 */
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

async function generateOne(dir, asset, style, size) {
  const label = `${dir}/${asset.element}.png`;
  console.log(`產生中: ${label} ...`);
  const jpegBuf = await fetchJpeg(`${asset.prompt}, ${style}`, size, asset.seed);
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const removedRatio = floodFillTransparentBackground(decoded.data, decoded.width, decoded.height, BACKGROUND_TOLERANCE);
  const pngBuffer = PNG.sync.write({ width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) });

  const outDir = path.join(PUBLIC_ASSETS_DIR, dir);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${asset.element}.png`), pngBuffer);
  console.log(`✅ ${label}(去背比例 ${(removedRatio * 100).toFixed(1)}%)`);
}

async function main() {
  const jobs = [
    ...TOWER_ASSETS.map((a) => ({ dir: 'towers', asset: a, style: TOWER_STYLE, size: TOWER_SIZE })),
    ...MONSTER_ASSETS.map((a) => ({ dir: 'monsters', asset: a, style: MONSTER_STYLE, size: MONSTER_SIZE })),
  ];
  for (const job of jobs) {
    try {
      await generateOne(job.dir, job.asset, job.style, job.size);
    } catch (err) {
      console.error(`❌ ${job.dir}/${job.asset.element}: ${err.message}`);
    }
    await sleep(6000); // 每張圖之間留緩衝,不要一產完馬上送下一張
  }
  console.log('完成。去背比例如果明顯偏低(<50%)或偏高(>95%),建議手動檢查那張圖。');
}

main();
