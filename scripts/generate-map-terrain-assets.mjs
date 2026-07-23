// 一次性批次腳本:幫每張地圖產各自的地板/路徑材質,讓三張地圖一眼就看得出是不同場景
// (原本三張共用同一套草地+土路,只有路徑形狀不同,視覺上分不出來)。
//
// 存進 public/assets/tiles/<mapId>/floor.png、path.png,對應 src/sim/map.ts 的 MAP_DEFS。
// GameScene.ts 的 drawStaticLayer() 會先找當前地圖專屬的材質,找不到才退回共用的
// tiles/floor.png / tiles/path.png,再找不到才退回純色棋盤格(三層備援)。
//
// 用法:node scripts/generate-map-terrain-assets.mjs
//
// **跟 generate-terrain-assets.mjs 的差別**:那支用 HuggingFace(需要 HF_TOKEN 環境變數),
// 這支改用免金鑰的 Pollinations(跟 generate-decor-assets.mjs 同一個 API),不用申請 token
// 就能跑。無縫鋪磚的後處理邏輯是從那支複製過來的(wrap-shift + 漸層混合),兩邊要一起維護。
//
// **crossroads 刻意不在這裡產**:它用的就是現有的 tiles/floor.png / path.png——那組已經
// 經過一輪「太亮太飽和」的調校,重產反而可能退步,直接讓它走共用材質的備援路徑就好。

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import pngjsPkg from 'pngjs';

const { PNG } = pngjsPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_DIR = path.join(__dirname, '..', 'public', 'assets', 'tiles');
const SIZE = 256;

// 跟 generate-terrain-assets.mjs 同一套風格基準:Kingdom Rush 調性但柔和低飽和
// (實測過「飽和暖色調」會生出螢光綠地板/亮橘路徑,長時間看不舒服)。
const STYLE_SUFFIX =
  'cute chibi cartoon tower defense game texture in the visual spirit of Kingdom Rush, soft muted low-saturation colors, gentle pastel-leaning palette, painterly style, top-down seamless tileable texture, flat even lighting, no objects, no shadows, no characters, no text, no watermark, subtle natural variation';

// 負面提示詞:第一版沒有明確禁止「物體」,結果草地材質裡混了小箱子/羊群之類的離散造型,
// 重複貼滿地圖會變成很怪的重複圖案。
const NEGATIVE =
  'EMPTY ground with nothing on it, absolutely no crates, no boxes, no wooden containers, no baskets, no sheep, no animals, no creatures, no props, no icons, no items, no plants sticking out';

const MAP_TERRAINS = [
  {
    mapId: 'serpent',
    // 長蛇迴廊:乾旱峽谷風,跟 crossroads 的草原拉開距離
    floor: {
      seed: 9201,
      prompt: `plain muted dusty ochre cartoon desert sand ground surface, soft desaturated sandy tone, like a video game level base terrain paint, only fine sand grain and subtle color variation, ${NEGATIVE}, ${STYLE_SUFFIX}`,
    },
    path: {
      seed: 9202,
      prompt: `plain muted grey cartoon cracked stone slab road surface, soft desaturated stone tone, like a video game level base terrain paint, only subtle cracks and color variation, ${NEGATIVE}, ${STYLE_SUFFIX}`,
    },
  },
  {
    mapId: 'trident',
    // 三叉分流:雪原風,冷色調跟前兩張的暖色系形成對比
    floor: {
      seed: 9301,
      prompt: `plain muted pale blue-white cartoon snow ground surface, soft desaturated cold tone, like a video game level base terrain paint, only gentle snow texture and subtle color variation, ${NEGATIVE}, ${STYLE_SUFFIX}`,
    },
    path: {
      seed: 9302,
      prompt: `plain muted slate grey cartoon frozen gravel trail surface, soft desaturated cold tone with faint ice sheen, like a video game level base terrain paint, only small frozen pebbles and subtle color variation, ${NEGATIVE}, ${STYLE_SUFFIX}`,
    },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pollinations 免費匿名額度同時間只能有 1 個請求在排隊(queueInfo.maxAllowed=1),
 * 打太快會被 429/500 擋掉,所以要重試 + 退避。實測跑一輪要好幾分鐘是正常的。
 */
async function fetchFromPollinations(prompt, seed) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${SIZE}&height=${SIZE}&seed=${seed}&nologo=true`;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const contentType = res.headers.get('content-type') ?? '';
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, contentType };
      }
      const backoffMs = attempt * 8000;
      console.warn(`    HTTP ${res.status},第 ${attempt}/${maxAttempts} 次,等 ${backoffMs / 1000}s 後重試`);
      await sleep(backoffMs);
    } catch (err) {
      const backoffMs = attempt * 8000;
      console.warn(`    ${err.message},第 ${attempt}/${maxAttempts} 次,等 ${backoffMs / 1000}s 後重試`);
      await sleep(backoffMs);
    }
  }
  throw new Error(`重試 ${maxAttempts} 次後仍失敗`);
}

/** Pollinations 可能回 jpeg 或 png,兩種都要能解;webp 沒有純 JS 解碼庫,遇到就當失敗。 */
function decodeImage(buf, contentType) {
  if (contentType.includes('png')) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { data: decoded.data, width: decoded.width, height: decoded.height };
  }
  throw new Error(`不支援的圖片格式 ${contentType}(沒有純 JS 解碼庫)`);
}

/** 沿 x/y 各位移半張圖(wrap-around),外緣因此保證能無縫接起來,但正中央會多一個十字接縫。 */
function wrapShiftHalf(data, width, height) {
  const shifted = new Uint8Array(data.length);
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    const sy = (y + halfH) % height;
    for (let x = 0; x < width; x++) {
      const sx = (x + halfW) % width;
      const srcIdx = (sy * width + sx) * 4;
      const dstIdx = (y * width + x) * 4;
      shifted[dstIdx] = data[srcIdx];
      shifted[dstIdx + 1] = data[srcIdx + 1];
      shifted[dstIdx + 2] = data[srcIdx + 2];
      shifted[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  return shifted;
}

/**
 * 拿原圖(正中央沒有接縫問題)跟位移圖(外緣保證接得起來)做漸層混合,修掉位移後
 * 正中央的十字接縫,同時不破壞外緣的無縫特性。
 * 已知限制:正中央會留下一圈稍微模糊的過渡區,鋪滿地圖時每個材質週期重複一次,
 * 不是完美無縫,但比硬接縫好很多(遊戲裡也會疊裝飾物打散單調感)。
 */
function makeSeamlessTile(data, width, height) {
  const shifted = wrapShiftHalf(data, width, height);
  const halfW = width / 2;
  const halfH = height / 2;
  const blendBandX = width * 0.28;
  const blendBandY = height * 0.28;
  const out = new Uint8Array(data.length);

  for (let y = 0; y < height; y++) {
    const distY = Math.abs(y - halfH);
    const wy = distY >= blendBandY ? 1 : distY / blendBandY;
    for (let x = 0; x < width; x++) {
      const distX = Math.abs(x - halfW);
      const wx = distX >= blendBandX ? 1 : distX / blendBandX;
      const w = Math.min(wx, wy); // 1=用位移圖(外緣安全) 0=用原圖(正中央安全)
      const idx = (y * width + x) * 4;
      out[idx] = Math.round(shifted[idx] * w + data[idx] * (1 - w));
      out[idx + 1] = Math.round(shifted[idx + 1] * w + data[idx + 1] * (1 - w));
      out[idx + 2] = Math.round(shifted[idx + 2] * w + data[idx + 2] * (1 - w));
      out[idx + 3] = 255;
    }
  }
  return out;
}

async function generateOne(mapId, kind, spec) {
  const label = `tiles/${mapId}/${kind}.png`;
  console.log(`產生中: ${label} ...`);
  const { buf, contentType } = await fetchFromPollinations(spec.prompt, spec.seed);
  const decoded = decodeImage(buf, contentType);
  const seamless = makeSeamlessTile(decoded.data, decoded.width, decoded.height);
  const pngBuffer = PNG.sync.write({
    width: decoded.width,
    height: decoded.height,
    data: Buffer.from(seamless),
  });
  const outDir = path.join(TILES_DIR, mapId);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${kind}.png`), pngBuffer);
  console.log(`✅ ${label}(${pngBuffer.length} bytes)`);
}

async function main() {
  let failed = 0;
  for (const terrain of MAP_TERRAINS) {
    for (const kind of ['floor', 'path']) {
      try {
        await generateOne(terrain.mapId, kind, terrain[kind]);
      } catch (err) {
        failed++;
        console.error(`❌ tiles/${terrain.mapId}/${kind}: ${err.message}`);
      }
      await sleep(3000); // 對免費額度客氣一點,不要連續猛打
    }
  }
  console.log(failed === 0 ? '\n完成,全部成功。' : `\n完成,但有 ${failed} 張失敗(可以重跑,已成功的會被覆蓋成同樣內容)。`);
}

main();
