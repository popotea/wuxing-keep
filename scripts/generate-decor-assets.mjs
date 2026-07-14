// 一次性批次腳本:直接呼叫免金鑰的 Pollinations 圖片 API,產生地圖裝飾用的動植物小圖示,
// 存進 public/assets/decor/。跳過 tools/ai-hub 那套「瀏覽器生成+去背+人工確認」互動流程
// (使用者已同意這個取捨),所以圖片背景不會是透明的——prompt 裡特別要求「站在草地上」,
// 讓沒去背的方形背景至少跟 GameScene 畫的草地大致融合。
// 用法:node scripts/generate-decor-assets.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'decor');

const STYLE_SUFFIX =
  'true top-down view, single subject centered, sitting on plain green grass, simple flat game art style, soft outline, no other objects, no text, no watermark';

const DECORATIONS = [
  { name: 'metal-crystal', prompt: `a small cluster of shiny metallic ore crystals, ${STYLE_SUFFIX}`, seed: 101 },
  { name: 'metal-fox', prompt: `a small silver fox standing, ${STYLE_SUFFIX}`, seed: 102 },
  { name: 'wood-bush', prompt: `a small green bush shrub, ${STYLE_SUFFIX}`, seed: 201 },
  { name: 'wood-deer', prompt: `a small brown deer standing, ${STYLE_SUFFIX}`, seed: 202 },
  { name: 'water-lily', prompt: `a cluster of lily pads with one flower, ${STYLE_SUFFIX}`, seed: 301 },
  { name: 'water-frog', prompt: `a small blue frog, ${STYLE_SUFFIX}`, seed: 302 },
  { name: 'fire-cactus', prompt: `a small glowing ember-orange cactus plant, ${STYLE_SUFFIX}`, seed: 401 },
  { name: 'fire-salamander', prompt: `a small red fire salamander lizard, ${STYLE_SUFFIX}`, seed: 402 },
  { name: 'earth-boulder', prompt: `a small mossy brown boulder rock, ${STYLE_SUFFIX}`, seed: 501 },
  { name: 'earth-tortoise', prompt: `a small brown tortoise, ${STYLE_SUFFIX}`, seed: 502 },
];

const SIZE = 256;

function extFromContentType(ct) {
  if (ct?.includes('png')) return 'png';
  if (ct?.includes('webp')) return 'webp';
  return 'jpg';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 免費匿名額度同時間只能有 1 個請求在排隊(queueInfo.maxAllowed=1),打太快會被 429/500 擋掉,
// 所以每張圖之間要等、遇到限流要重試,不能狂送。
async function generateOne(decor) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(decor.prompt)}?width=${SIZE}&height=${SIZE}&seed=${decor.seed}&nologo=true`;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const ext = extFromContentType(res.headers.get('content-type'));
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(OUT_DIR, `${decor.name}.${ext}`);
      await writeFile(file, buf);
      console.log(`✅ ${decor.name}.${ext} (${buf.length} bytes)`);
      return `${decor.name}.${ext}`;
    }
    const backoffMs = attempt * 8000;
    console.warn(`  ${decor.name}: HTTP ${res.status},第 ${attempt}/${maxAttempts} 次,等 ${backoffMs / 1000}s 後重試`);
    await sleep(backoffMs);
  }
  throw new Error(`${decor.name}: 重試 ${maxAttempts} 次後仍失敗`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = {};
  for (const decor of DECORATIONS) {
    try {
      manifest[decor.name] = await generateOne(decor);
    } catch (err) {
      console.error(`❌ ${decor.name}: ${err.message}`);
    }
    await sleep(6000); // 每張圖之間留緩衝,不要一產完馬上送下一張
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('完成,manifest.json 已寫入(GameScene.ts 依這份清單載入實際副檔名)。');
}

main();
