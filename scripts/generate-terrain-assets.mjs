// 一次性批次腳本:呼叫 HuggingFace Inference API 產生地板/路徑材質,存進
// public/assets/tiles/floor.png、path.png(對照 src/game/GameScene.ts 的
// TILE_IMAGE_FILES,tools/ai-hub 原本規劃的 GAME_ASSETS 'assets/tiles/' 分類)。
//
// 需要環境變數 HF_TOKEN(HuggingFace 的 API token,不要寫死在檔案裡、不要 commit)。
// 用法:HF_TOKEN=hf_xxx node scripts/generate-terrain-assets.mjs
//
// 舊的 https://api-inference.huggingface.co 網域已經停用,新版走
// https://router.huggingface.co/hf-inference/models/<model>。
//
// 材質是要整格鋪滿重複貼的(Phaser TileSprite),AI 生的圖天生邊緣對不起來、
// 直接鋪滿會有明顯格線接縫,所以額外做「seamless tiling」後處理:把圖沿 x/y
// 各位移半張圖(wrap-around),這樣圖的四個外緣會自然接起來(位移前相鄰的像素
// 現在變成對邊的像素),但位移後的正中央會出現一個十字形接縫(四個原始角落
// 現在擠在一起)。修法是拿「位移前的原圖」在正中央跟「位移後的圖」在外緣之間
// 做漸層混合——原圖的正中央本來就是一般照片內容沒有接縫問題,位移圖的外緣
// 本來就保證能接起來,兩者各自安全的區域接起來就不會看到接縫。
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import pngjsPkg from 'pngjs';

const { PNG } = pngjsPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'tiles');

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.error('缺少環境變數 HF_TOKEN,用法:HF_TOKEN=hf_xxx node scripts/generate-terrain-assets.mjs');
  process.exit(1);
}

const HF_MODEL = 'black-forest-labs/FLUX.1-schnell';
const HF_URL = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`;
const SIZE = 256;

// 參考「其他遊戲UI參考/」資料夾裡的 Kingdom Rush 系列截圖調性:飽和暖色調的卡通地面材質,
// 不是寫實照片風格,跟塔/怪物的 Q 版可愛方向一致。
const STYLE_SUFFIX =
  'cute chibi cartoon tower defense game texture in the visual spirit of Kingdom Rush, warm saturated colors, painterly style, top-down seamless tileable texture, flat even lighting, no objects, no shadows, no characters, no text, no watermark, subtle natural variation';

const TERRAIN_ASSETS = [
  {
    name: 'floor',
    prompt: `plain lush green cartoon grass ground surface, like a video game level base terrain paint, only small blades of grass and subtle color variation, absolutely no crates, no sheep, no animals, no creatures, no props, no icons, no items, ${STYLE_SUFFIX}`,
  },
  {
    name: 'path',
    prompt: `plain warm tan cartoon dirt path surface, like a video game level base terrain paint, only small pebbles and subtle color variation, absolutely no crates, no animals, no creatures, no props, no icons, no items, ${STYLE_SUFFIX}`,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HF 免費額度的模型偶爾要「冷啟動」,會回一段 JSON 說還在載入、要等幾秒,不是圖檔內容。 */
async function fetchFromHf(prompt) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: prompt, parameters: { width: SIZE, height: SIZE } }),
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (res.ok && contentType.startsWith('image/')) {
      return Buffer.from(await res.arrayBuffer());
    }
    const bodyText = await res.text();
    let waitMs = attempt * 5000;
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed.estimated_time) waitMs = Math.ceil(parsed.estimated_time * 1000) + 1000;
      console.warn(`  HTTP ${res.status}: ${parsed.error ?? bodyText},第 ${attempt}/${maxAttempts} 次,等 ${(waitMs / 1000).toFixed(1)}s 後重試`);
    } catch {
      console.warn(`  HTTP ${res.status}(非圖片回應),第 ${attempt}/${maxAttempts} 次,等 ${(waitMs / 1000).toFixed(1)}s 後重試`);
    }
    await sleep(waitMs);
  }
  throw new Error(`重試 ${maxAttempts} 次後仍失敗`);
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
 * 正中央的十字接縫,同時不破壞外緣的無縫特性。回傳新的 seamless 材質。
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

async function generateOne(asset) {
  console.log(`產生中: tiles/${asset.name}.png ...`);
  const jpegBuf = await fetchFromHf(asset.prompt);
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const seamless = makeSeamlessTile(decoded.data, decoded.width, decoded.height);
  const pngBuffer = PNG.sync.write({ width: decoded.width, height: decoded.height, data: Buffer.from(seamless) });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, `${asset.name}.png`), pngBuffer);
  console.log(`✅ tiles/${asset.name}.png`);
}

async function main() {
  for (const asset of TERRAIN_ASSETS) {
    try {
      await generateOne(asset);
    } catch (err) {
      console.error(`❌ tiles/${asset.name}: ${err.message}`);
    }
  }
  console.log('完成。');
}

main();
