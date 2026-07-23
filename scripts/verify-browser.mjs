// 實機瀏覽器驗證(npm run verify:browser)。
//
// 涵蓋三塊 verify-sim.mjs 測不到、只有真的開瀏覽器才驗證得了的東西:
//   (A) 每張地圖的單人流程能不能跑(開局/技能施放/建造/無 console error)
//   (B) 同一個分頁連續換地圖時,靜態層(地板/路徑/裝飾物)有沒有真的重畫
//   (C) 多人 2 玩家在同一個 tick 上的 checksum 是不是位元級一致
//
// 前置需求:
//   1. 另一個終端機跑著 `npm run dev`(這支腳本不會自己啟動 dev server)
//   2. Playwright。**刻意沒有列進 package.json 的 devDependencies**——它會連帶下載
//      瀏覽器(數百 MB),不該是每個 clone 這個專案的人都被迫裝的東西。
//      要跑的話自己裝:`npm i -D playwright && npx playwright install chromium`
//      (或用 npx 臨時跑,不寫進專案)。
//
// 詳細的多人驗證方法論見 .claude/skills/multiplayer-verify skill。

const BASE_URL = process.env.WUXING_VERIFY_URL ?? 'http://localhost:5173/';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    '\n找不到 playwright。這支腳本刻意不把它列進專案依賴(會連帶下載數百 MB 的瀏覽器)。\n' +
      '要跑的話先裝:\n' +
      '  npm i -D playwright\n' +
      '  npx playwright install chromium\n',
  );
  process.exit(2);
}

const failures = [];
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures.push(name);
}

// dev server 沒開的話早點給明確訊息,不要等到 goto 逾時才報一堆看不懂的東西。
try {
  const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.error(`\n連不上 ${BASE_URL}。請先在另一個終端機執行 \`npm run dev\`。\n`);
  process.exit(2);
}

const browser = await chromium.launch();
const MAP_IDS = ['crossroads', 'serpent', 'trident'];

// ---------------------------------------------------------------------------
// (A) 每張地圖的單人流程
// ---------------------------------------------------------------------------
for (const mapId of MAP_IDS) {
  console.log(`\n=== (A) 單人流程:${mapId} ===`);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.selectOption('#soloMap', mapId);
  const hint = await page.textContent('#soloMapHint');
  check('地圖說明跟著切換', !!hint && hint.length > 5, `hint="${hint}"`);

  await page.click('#soloBtn');
  await page.waitForTimeout(2500);

  const dbg = await page.evaluate(() => window.__wuxingDebug);
  check('模擬有在跑', dbg && dbg.tick > 10, JSON.stringify(dbg));
  check('技能列有 3 顆按鈕', (await page.locator('.skill-btn').count()) === 3);

  const goldBefore = await page.textContent('#gold');
  await page.locator('.skill-btn[data-skill="meteor"]').click();
  check('點技能後進入施放模式', (await page.locator('.skill-btn[data-skill="meteor"].skill-arming').count()) === 1);

  const box = await page.locator('#gameCanvas canvas').first().boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(400);

  const cdText = await page.locator('.skill-btn[data-skill="meteor"] .skill-btn-cd').textContent();
  check('施放後顯示冷卻秒數', /\d+s/.test(cdText), `顯示 "${cdText}"`);
  check('冷卻中按鈕 disabled', await page.locator('.skill-btn[data-skill="meteor"]').isDisabled());
  check('技能不花金幣', goldBefore === (await page.textContent('#gold')));

  // 點幾個位置直到跳出建造選單(不同地圖的空地位置不一樣,不寫死座標)
  let built = false;
  for (const [fx, fy] of [
    [0.2, 0.2],
    [0.3, 0.35],
    [0.6, 0.25],
    [0.75, 0.6],
    [0.45, 0.75],
  ]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(250);
    if ((await page.locator('#floatingBuildMenu.show').count()) > 0) {
      const opt = page.locator('#floatingBuildMenu .build-option, #floatingBuildMenu button').first();
      if ((await opt.count()) > 0) {
        await opt.click();
        await page.waitForTimeout(300);
        built = true;
        break;
      }
    }
  }
  check('能開建造選單並蓋東西', built);

  await page.waitForTimeout(1500);
  check('模擬持續前進', (await page.evaluate(() => window.__wuxingDebug)).tick > dbg.tick);
  check('沒有 console error', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// (B) 同一分頁連續換地圖 —— 靜態層有沒有重畫
// ---------------------------------------------------------------------------
console.log('\n=== (B) 同一分頁連續換地圖 ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const shots = {};
  for (const [key, mapId] of [
    ['first', 'crossroads'],
    ['other', 'serpent'],
    ['again', 'crossroads'],
  ]) {
    await page.selectOption('#soloMap', mapId);
    await page.click('#soloBtn');
    await page.waitForTimeout(1800);
    shots[key] = await page.locator('#gameCanvas canvas').first().screenshot();
    // 「回到選單」在對局進行中是隱藏的(只有結束後才顯示),用 DOM 直接觸發 click 繞過
    // 可見性限制——走的仍是真正的 listener,只是省掉「先把這局玩到結束」的時間。
    await page.evaluate(() => document.getElementById('backToMenuBtn').click());
    await page.waitForTimeout(800);
  }

  // 解碼 PNG 取特定格子中心的像素,判斷那格畫的是路徑還是草地。
  // **不能比對 PNG 壓縮後的 bytes**——壓縮資料只要有一點差異後續就全不同,算出來的
  // 「差異率」永遠接近 1,兩張圖再像也分不出來(第一版就是這樣完全測不到東西)。
  const { PNG } = await import('pngjs');
  const GRID_W = 40;
  const GRID_H = 24;
  const pixelAt = (buf, gx, gy) => {
    const png = PNG.sync.read(buf);
    const px = Math.floor(((gx + 0.5) / GRID_W) * png.width);
    const py = Math.floor(((gy + 0.5) / GRID_H) * png.height);
    const idx = (png.width * py + px) << 2;
    return [png.data[idx], png.data[idx + 1], png.data[idx + 2]];
  };
  // 路徑材質是土色(r > g),草地是綠色(g > r)。
  const looksLikePath = ([r, g]) => r > g;

  // (0,12):crossroads 是路徑起點,serpent 在這格是草地(它的 y=12 那段從 x=3 才開始)
  // (0,2) :serpent 是路徑起點,crossroads 在這格是草地
  check('crossroads:(0,12) 畫成路徑', looksLikePath(pixelAt(shots.first, 0, 12)));
  check('crossroads:(0,2) 畫成草地', !looksLikePath(pixelAt(shots.first, 0, 2)));
  check('serpent:(0,2) 畫成路徑(新地圖的路徑有出現)', looksLikePath(pixelAt(shots.other, 0, 2)));
  check('serpent:(0,12) 畫成草地(舊地圖的路徑沒殘留)', !looksLikePath(pixelAt(shots.other, 0, 12)));
  check('換回 crossroads:(0,12) 又變回路徑', looksLikePath(pixelAt(shots.again, 0, 12)));
  check('換回 crossroads:(0,2) 又變回草地', !looksLikePath(pixelAt(shots.again, 0, 2)));
  check('全程沒有 console error', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// (C) 多人 2 玩家 checksum 一致性
// ---------------------------------------------------------------------------
console.log('\n=== (C) 多人 2 玩家 checksum ===');
{
  // 每個玩家要用獨立的 BrowserContext——同一個 context 內的分頁共用儲存空間,
  // PeerJS 的 Peer 身分會互相干擾,測不出真實情況。
  const ctxHost = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxGuest = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await ctxHost.newPage();
  const guest = await ctxGuest.newPage();
  const errors = [];
  for (const [p, tag] of [
    [host, 'host'],
    [guest, 'guest'],
  ]) {
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`);
    });
    p.on('pageerror', (e) => errors.push(`${tag}: ${e}`));
  }

  await host.goto(BASE_URL, { waitUntil: 'networkidle' });
  await host.click('#tabMulti');
  // 刻意選路徑數跟預設不同的地圖,順便驗證 mapId 有正確傳到客戶端
  await host.selectOption('#hostMap', 'trident');
  await host.click('#hostBtn');
  await host.waitForSelector('#roomCode:not(:empty)', { timeout: 30000 });
  const code = (await host.textContent('#roomCode')).trim();
  console.log(`  房號:${code}`);

  await guest.goto(BASE_URL, { waitUntil: 'networkidle' });
  await guest.click('#tabMulti');
  await guest.click('#subTabJoin');
  await guest.fill('#joinCode', code);
  await guest.click('#joinBtn');
  await guest.waitForTimeout(4000);

  check('客戶端有加入房間', /2/.test((await host.textContent('#rosterCount')) || ''));

  await host.click('#readyBtn');
  await guest.click('#readyBtn');
  await host.waitForTimeout(1200);
  await host.click('#startBtn');
  await host.waitForTimeout(6000);

  // 兩邊各放一次技能,製造「有指令」的狀況(不只是空心跳 tick)
  const castOn = async (page) => {
    const btn = page.locator('.skill-btn:not([disabled])').first();
    if ((await btn.count()) === 0) return;
    await btn.click();
    const box = await page.locator('#gameCanvas canvas').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  };
  await castOn(host);
  await guest.waitForTimeout(500);
  await castOn(guest);
  await host.waitForTimeout(6000);

  // 各自取一連串 (tick -> checksum),再找共同 tick 比對——一定要在**同一個 tick** 上比,
  // 不同 tick 的兩個值沒有比較意義。
  const sample = async (page) => {
    const out = {};
    for (let i = 0; i < 40; i++) {
      const d = await page.evaluate(() => window.__wuxingDebug);
      if (d && d.tick != null) out[d.tick] = d.checksum;
      await page.waitForTimeout(60);
    }
    return out;
  };
  const [a, b] = await Promise.all([sample(host), sample(guest)]);
  const shared = Object.keys(a).filter((t) => t in b);
  check('兩邊有共同的 tick 可比對', shared.length >= 3, `共同 tick 數 ${shared.length}`);
  const mismatches = shared.filter((t) => a[t] !== b[t]);
  check(
    '所有共同 tick 的 checksum 完全一致(lockstep 沒跑飛)',
    mismatches.length === 0,
    mismatches.slice(0, 5).map((t) => `tick ${t}: ${a[t]} vs ${b[t]}`).join(' | '),
  );
  if (shared.length > 0) {
    console.log(`  比對了 ${shared.length} 個共同 tick,範圍 ${shared[0]}~${shared[shared.length - 1]}`);
  }
  check('對局有實際推進', (await host.evaluate(() => window.__wuxingDebug)).tick > 100);
  check('多人流程沒有 console error', errors.length === 0, errors.slice(0, 3).join(' | '));

  await ctxHost.close();
  await ctxGuest.close();
}

await browser.close();
console.log(`\n${failures.length === 0 ? '全部通過' : `${failures.length} 項失敗:${failures.join(', ')}`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
