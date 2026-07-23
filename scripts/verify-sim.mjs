// 模擬層決定性驗證(npm run verify)。
//
// 專案沒有測試框架,這支腳本就是 src/sim/ 的回歸測試:用 esbuild 把模擬層打包成 ESM
// 直接在 Node 跑,驗證「同樣的輸入在任何機器上算出位元級相同的結果」這條鐵則沒被破壞,
// 以及各項玩法機制真的會發生(不是只有型別過)。
//
// 改過 src/sim/ 底下任何東西都應該跑一次。多人連線的實際同步驗證見 verify-browser.mjs
// 跟 .claude/skills/multiplayer-verify skill。
//
// esbuild 來自 vite 的傳遞依賴(沒有列在 package.json 的 devDependencies)。
// 之後如果換掉 vite,記得把 esbuild 自己加進 devDependencies,不然這支腳本會壞。

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = mkdtempSync(join(tmpdir(), 'wuxing-verify-'));

/** 把一個 TS 模組打包成 ESM 再 import 回來,這樣 Node 不用任何 TS loader 就能直接跑。 */
async function loadModule(entry, name) {
  const outfile = join(outDir, name);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}

const sim = await loadModule('src/sim/simulation.ts', 'sim.mjs');
const mapMod = await loadModule('src/sim/map.ts', 'map.mjs');
const statusMod = await loadModule('src/sim/statuses.ts', 'statuses.mjs');
const monsterMod = await loadModule('src/sim/monsters.ts', 'monsters.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[1] 地圖定義');
// waypoints 必須水平/垂直對齊(advanceAlongPath 的前提)且不能超出邊界。
for (const def of mapMod.MAP_DEFS) {
  mapMod.setActiveMap(def.id);
  let ok = true;
  let detail = '';
  for (const path of def.paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, ay] = path[i];
      const [bx, by] = path[i + 1];
      if (ax !== bx && ay !== by) {
        ok = false;
        detail = `斜線段 ${ax},${ay} -> ${bx},${by}`;
      }
    }
    for (const [x, y] of path) {
      if (x < 0 || x >= mapMod.GRID_WIDTH || y < 0 || y >= mapMod.GRID_HEIGHT) {
        ok = false;
        detail = `超出邊界 ${x},${y}`;
      }
    }
  }
  check(`${def.id}(${def.paths.length} 條路徑)waypoints 合法`, ok, detail);
  check(`${def.id} pathCount() 跟定義一致`, mapMod.pathCount() === def.paths.length);
}

// ---------------------------------------------------------------------------
console.log('\n[2] 擊退(retreatAlongPath)邊界');
mapMod.setActiveMap(mapMod.DEFAULT_MAP_ID);
{
  let pos = mapMod.createStartPos(0);
  for (let i = 0; i < 50; i++) pos = mapMod.advanceAlongPath(pos, 500).pos;
  const before = mapMod.remainingDistanceFp(pos);
  const back = mapMod.retreatAlongPath(pos, 900);
  check('擊退後剩餘距離變大(真的往回退)', mapMod.remainingDistanceFp(back) > before);
  check('擊退不會換到別條路徑', back.pathId === pos.pathId);
  check('擊退後 distanceIntoSegmentFp 非負', back.distanceIntoSegmentFp >= 0);

  // 在起點被擊退不能變成負值,也不能溢位到「上一條路徑」。
  const atStart = mapMod.createStartPos(0);
  const clamped = mapMod.retreatAlongPath(atStart, 99999);
  check('起點擊退夾在 0(不會變負)', clamped.segmentIndex === 0 && clamped.distanceIntoSegmentFp === 0);
}

// ---------------------------------------------------------------------------
console.log('\n[3] 決定性雜湊(statusRoll)');
{
  const a = [];
  const b = [];
  for (let t = 0; t < 200; t++) {
    a.push(statusMod.statusRoll(t, 3, 17));
    b.push(statusMod.statusRoll(t, 3, 17));
  }
  check('同輸入同輸出', a.join(',') === b.join(','));
  check('值域落在 0..99', a.every((v) => v >= 0 && v < 100));
  const distinct = new Set(a).size;
  check('分布夠分散(>50 種值)', distinct > 50, `實際 ${distinct} 種`);
  check('首領抗性至少留 1 tick(不會完全免疫)', statusMod.applyBossResist(1, true) >= 1);
  check('非首領不打折', statusMod.applyBossResist(40, false) === 40);
}

// ---------------------------------------------------------------------------
console.log('\n[4] 無限模式生怪');
{
  const run = () => {
    const out = [];
    for (let w = 0; w < 40; w++) {
      const ev = monsterMod.getEndlessSpawnEventsForTick(w * monsterMod.WAVE_INTERVAL_TICKS);
      out.push(ev.map((e) => `${e.element}/${e.moveType}/${e.ability}/${e.hp}`).join('|'));
    }
    return out.join(';');
  };
  check('生怪內容完全決定性', run() === run());

  const abilities = new Set();
  for (let w = 0; w < 60; w++) {
    for (let j = 0; j < 20; j++) {
      const tick = w * monsterMod.WAVE_INTERVAL_TICKS + j * monsterMod.SPAWN_INTERVAL_TICKS;
      for (const e of monsterMod.getEndlessSpawnEventsForTick(tick)) abilities.add(e.ability);
    }
  }
  check('60 波內會出現多種特殊能力', abilities.size >= 4, `實際 ${[...abilities].join(',')}`);
}

// ---------------------------------------------------------------------------
console.log('\n[5] 完整對局(每張地圖跑兩次比對 checksum 序列)');
for (const def of mapMod.MAP_DEFS) {
  const mapId = def.id;

  const runMatch = () => {
    let s = sim.createInitialState(
      12345,
      100,
      { p1: ['metal', 'wood', 'water', 'fire', 'earth'] },
      false,
      false,
      mapId,
    );
    // 先給錢再送建塔指令:初始金幣只蓋得起 4 座,後面的指令會因為錢不夠被安全忽略,
    // 塔太少就打不出足夠的擊殺/狀態觸發,測不到要測的東西。
    // (直接改 state 是驗證腳本的特權,不是遊戲流程做得到的事。)
    s.gold.p1 = 999999;

    // 沿整條路徑「均勻」布防。不能照 x/y 掃描順序取前 N 個候選格——那會讓塔全部擠在
    // 地圖左緣,長路徑地圖(serpent)的怪走出射程後就一路無阻走到終點,分裂怪永遠不會
    // 被殺死,測不到擊殺相關的行為。
    const candidates = [];
    for (const path of def.paths) {
      for (let i = 0; i < path.length - 1; i++) {
        const [ax, ay] = path[i];
        const [bx, by] = path[i + 1];
        const dx = Math.sign(bx - ax);
        const dy = Math.sign(by - ay);
        const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
        for (let s2 = 0; s2 <= steps; s2++) {
          const tx = ax + dx * s2;
          const ty = ay + dy * s2;
          for (const [ox, oy] of [
            [0, -1],
            [0, 1],
            [-1, 0],
            [1, 0],
          ]) {
            const cx = tx + ox;
            const cy = ty + oy;
            if (cx < 0 || cx >= mapMod.GRID_WIDTH || cy < 0 || cy >= mapMod.GRID_HEIGHT) continue;
            if (mapMod.isOnPath(cx, cy)) continue;
            if (!candidates.some(([qx, qy]) => qx === cx && qy === cy)) candidates.push([cx, cy]);
          }
        }
      }
    }

    const elements = ['fire', 'water', 'wood', 'metal', 'earth'];
    const WANTED_TOWERS = 30;
    const stride = Math.max(1, Math.floor(candidates.length / WANTED_TOWERS));
    const buildCmds = [];
    let placed = 0;
    for (let i = 0; i < candidates.length && placed < WANTED_TOWERS; i += stride) {
      const [x, y] = candidates[i];
      buildCmds.push({
        playerId: 'p1',
        action: { kind: 'build_tower', params: { x, y, element: elements[placed % 5] } },
      });
      placed++;
    }
    s = sim.step(s, 0, buildCmds);

    const checksums = [];
    let sawStatus = false;
    let sawShield = false;
    let sawSplitChild = false;
    let sawSkillCast = false;
    for (let t = 1; t < 2600; t++) {
      const cmds = [];
      // 三個技能各放一次,確認 cast_skill 這條路徑有被走到。
      if (t === 500) cmds.push({ playerId: 'p1', action: { kind: 'cast_skill', params: { skill: 'meteor', x: 20, y: 12 } } });
      if (t === 520) cmds.push({ playerId: 'p1', action: { kind: 'cast_skill', params: { skill: 'frost', x: 20, y: 12 } } });
      if (t === 540) cmds.push({ playerId: 'p1', action: { kind: 'cast_skill', params: { skill: 'warcry', x: 20, y: 12 } } });
      s = sim.step(s, t, cmds);
      if (s.skillCasts.length > 0) sawSkillCast = true;
      for (const m of s.monsters) {
        if (m.statusBurnTicks > 0 || m.statusChillTicks > 0 || m.statusEntangleTicks > 0 || m.statusSunderTicks > 0) {
          sawStatus = true;
        }
        if (m.shieldHp > 0) sawShield = true;
        if (m.isSplitChild) sawSplitChild = true;
      }
      if (t % 200 === 0) checksums.push(`${t}:${s.checksum}`);
    }
    return { checksums: checksums.join(','), sawStatus, sawShield, sawSplitChild, sawSkillCast, final: s };
  };

  const first = runMatch();
  const second = runMatch();
  check(`[${mapId}] 兩次跑出完全相同的 checksum 序列`, first.checksums === second.checksums);
  check(`[${mapId}] 元素異常狀態有觸發`, first.sawStatus);
  check(`[${mapId}] 護盾兵有出現`, first.sawShield);
  check(`[${mapId}] 分裂小怪有生成`, first.sawSplitChild);
  check(`[${mapId}] 主動技能施放成功`, first.sawSkillCast);
  check(`[${mapId}] 沒有 NaN/負血怪殘留`, first.final.monsters.every((m) => Number.isFinite(m.hp) && m.hp > 0));
  check(
    `[${mapId}] 技能冷卻沒有變成負數`,
    Object.values(first.final.skillCooldowns).every((cds) => cds.every((c) => c >= 0)),
  );
}

// ---------------------------------------------------------------------------
console.log('\n[6] 第二屬性(升級解鎖)');
{
  const towersMod = await loadModule('src/sim/towers.ts', 'towers.mjs');
  const minLevel = towersMod.DUAL_ELEMENT_MIN_LEVEL;
  mapMod.setActiveMap(mapMod.DEFAULT_MAP_ID);

  // 找一個可以蓋塔的非路徑格
  let spot = null;
  for (let x = 0; x < mapMod.GRID_WIDTH && !spot; x++) {
    for (let y = 0; y < mapMod.GRID_HEIGHT && !spot; y++) {
      if (!mapMod.isOnPath(x, y)) spot = [x, y];
    }
  }
  const [tx, ty] = spot;

  const fresh = () => {
    let s = sim.createInitialState(7, 100, { p1: ['fire', 'water', 'metal'] }, false, false, mapMod.DEFAULT_MAP_ID);
    s.gold.p1 = 999999;
    s = sim.step(s, 0, [{ playerId: 'p1', action: { kind: 'build_tower', params: { x: tx, y: ty, element: 'fire' } } }]);
    return s;
  };

  // 1 級就想加第二屬性 → 應該被安全忽略
  let s = fresh();
  const towerId = s.towers[0].id;
  const goldBefore = s.gold.p1;
  s = sim.step(s, 1, [{ playerId: 'p1', action: { kind: 'add_second_element', params: { towerId, secondElement: 'water' } } }]);
  check(`等級未達 ${minLevel} 時加第二屬性被忽略`, s.towers[0].secondElement === undefined);
  check('被忽略時不會扣錢', s.gold.p1 === goldBefore);

  // 升到 minLevel 之後就可以加
  let t = 2;
  while (s.towers[0].level < minLevel) {
    s = sim.step(s, t++, [{ playerId: 'p1', action: { kind: 'upgrade_tower', params: { towerId } } }]);
  }
  check(`塔升到了 ${minLevel} 級`, s.towers[0].level === minLevel);
  const goldBeforeAdd = s.gold.p1;
  s = sim.step(s, t++, [{ playerId: 'p1', action: { kind: 'add_second_element', params: { towerId, secondElement: 'water' } } }]);
  check('等級達標後可以加第二屬性', s.towers[0].secondElement === 'water');
  const expectedCost = towersMod.secondElementCost('fire', 'water');
  check('扣款金額等於 secondElementCost', goldBeforeAdd - s.gold.p1 === expectedCost, `實扣 ${goldBeforeAdd - s.gold.p1},預期 ${expectedCost}`);

  // 已經有第二屬性就不能再改(跟分岐路線同一套慣例)
  const goldBefore2 = s.gold.p1;
  s = sim.step(s, t++, [{ playerId: 'p1', action: { kind: 'add_second_element', params: { towerId, secondElement: 'metal' } } }]);
  check('已定案的第二屬性不能再改', s.towers[0].secondElement === 'water');
  check('改不成時不會扣錢', s.gold.p1 === goldBefore2);

  // 跟主屬性相同 / 不在允許清單內 都要被忽略
  let s2 = fresh();
  const id2 = s2.towers[0].id;
  let t2 = 1;
  while (s2.towers[0].level < minLevel) {
    s2 = sim.step(s2, t2++, [{ playerId: 'p1', action: { kind: 'upgrade_tower', params: { towerId: id2 } } }]);
  }
  s2 = sim.step(s2, t2++, [{ playerId: 'p1', action: { kind: 'add_second_element', params: { towerId: id2, secondElement: 'fire' } } }]);
  check('第二屬性跟主屬性相同 → 忽略', s2.towers[0].secondElement === undefined);
  s2 = sim.step(s2, t2++, [{ playerId: 'p1', action: { kind: 'add_second_element', params: { towerId: id2, secondElement: 'wood' } } }]);
  check('第二屬性不在允許清單內 → 忽略', s2.towers[0].secondElement === undefined);

  // 舊的 build_dual_tower 指令已經移除,送出去應該完全沒作用(不是蓋出塔也不是扣錢)
  let s3 = sim.createInitialState(9, 100, { p1: ['fire', 'water'] }, false, false, mapMod.DEFAULT_MAP_ID);
  const goldBefore3 = s3.gold.p1;
  s3 = sim.step(s3, 0, [
    { playerId: 'p1', action: { kind: 'build_dual_tower', params: { x: tx, y: ty, element: 'fire', secondElement: 'water' } } },
  ]);
  check('舊的 build_dual_tower 指令已失效', s3.towers.length === 0 && s3.gold.p1 === goldBefore3);
}

// ---------------------------------------------------------------------------
console.log('\n[7] 技能冷卻');
{
  const mapId = mapMod.DEFAULT_MAP_ID;
  let s = sim.createInitialState(1, 100, { p1: ['fire'] }, false, false, mapId);
  s = sim.step(s, 0, [{ playerId: 'p1', action: { kind: 'cast_skill', params: { skill: 'meteor', x: 10, y: 12 } } }]);
  check('第一次施放成功', s.skillCasts.length === 1);
  check('施放後進入冷卻', s.skillCooldowns.p1[0] > 0, `實際 ${s.skillCooldowns.p1[0]}`);
  s = sim.step(s, 1, [{ playerId: 'p1', action: { kind: 'cast_skill', params: { skill: 'meteor', x: 10, y: 12 } } }]);
  check('冷卻中再施放被安全忽略', s.skillCasts.length === 0);
}

// ---------------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '全部通過' : `${failures} 項失敗`}\n`);
process.exit(failures === 0 ? 0 : 1);
