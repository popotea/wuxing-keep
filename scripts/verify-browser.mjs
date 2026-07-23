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

  /**
   * 整張畫面的平均色。
   *
   * **不能取單一格子的像素**:第一版這樣做,結果取到的 (0,12) 剛好是 crossroads 的
   * 怪物出生點,像素被路過的怪蓋掉,同一張地圖兩次量到的顏色就差很多(誤判成「有殘留」);
   * 而且土路跟沙地的顏色本來就接近,單點比對也分不出換了地圖(誤判成「沒重畫」)。
   * 取整張平均可以把怪物/裝飾物這些少數像素的影響攤掉,剩下的就是地形本身的色調。
   */
  const averageColor = (buf) => {
    const png = PNG.sync.read(buf);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    // 每隔幾個像素取一次就夠了,不用逐像素掃(整張 1280x800 太慢)
    for (let i = 0; i < png.data.length; i += 4 * 17) {
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      n++;
    }
    return [r / n, g / n, b / n];
  };
  // **不能用「路徑是土色 r>g、地面是綠色 g>r」這種色相判斷**:每張地圖現在有各自的
  // 地形材質(草原/沙漠/雪原),沙漠的沙地本身就是 r>g、雪原的石板路是冷藍 r<g,
  // 色相假設整個不成立。改成比「顏色距離」——不管實際是什麼顏色,只看有沒有變:
  //   換地圖 → 同一格的顏色應該差很多(靜態層真的重畫了)
  //   換回同一張地圖 → 同一格的顏色應該幾乎一樣(沒有殘留、也沒有畫錯)
  const colorDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const CHANGED = 40; // 三通道差值總和,超過這個就算「明顯不同」(草原↔沙漠實測遠大於此)
  const SAME = 12; // 低於這個就算「幾乎一樣」(平均色下,怪物位置不同只造成個位數差異)

  const first = averageColor(shots.first);
  const other = averageColor(shots.other);
  const again = averageColor(shots.again);
  const fmt = (c) => c.map((v) => Math.round(v)).join(',');

  check(
    '換地圖後整體色調明顯改變(靜態層有照新地圖重畫)',
    colorDist(first, other) > CHANGED,
    `dist=${colorDist(first, other).toFixed(1)} — crossroads(${fmt(first)}) vs serpent(${fmt(other)})`,
  );
  check(
    '換回同一地圖後色調復原(沒有殘留舊地圖)',
    colorDist(first, again) < SAME,
    `dist=${colorDist(first, again).toFixed(1)} — ${fmt(first)} vs ${fmt(again)}`,
  );
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
  await host.waitForTimeout(1000);

  // 加入者(guest)蓋一座塔:驗證「client 的指令真的有進模擬」——checksum 一致只證明兩邊
  // 一樣,證明不了指令生效(client 指令被丟掉時兩邊一致地沒有那座塔,checksum 照樣過,
  // 這正是 2026-07-23「加入者不能玩」回報原本測不到的原因)。塔數走 window.__wuxingDebug.towers。
  const tryBuildTower = async (page) => {
    const box = await page.locator('#gameCanvas canvas').first().boundingBox();
    for (const [fx, fy] of [
      [0.3, 0.3],
      [0.7, 0.35],
      [0.4, 0.7],
      [0.6, 0.6],
      [0.25, 0.55],
    ]) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(300);
      const menu = page.locator('#floatingBuildMenu.show');
      if ((await menu.count()) === 0) continue;
      const buttons = menu.locator('button.choice-option');
      // 非路徑格的建造選單至少有 5 屬性 + 資源建築 + 圖騰;只有 1-2 個選項代表點到路徑格
      // (只有陷阱)或塔選單,關掉換下一格。
      if ((await buttons.count()) >= 3) {
        await buttons.first().click();
        return true;
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    return false;
  };
  const guestBuilt = await tryBuildTower(guest);
  check('加入者能開建造選單蓋塔', guestBuilt);
  await host.waitForTimeout(1500);
  const hostView = await host.evaluate(() => window.__wuxingDebug);
  check('加入者的建塔指令有進模擬(房主端看得到那座塔)', (hostView?.towers ?? 0) >= 1, `host towers=${hostView?.towers}`);

  await host.waitForTimeout(4000);

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
