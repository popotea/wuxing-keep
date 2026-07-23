// 怪物與波次。固定模式的波次全部是寫死的腳本(數量/血量/速度/賞金都是常數),
// 完全不需要亂數——省掉「RNG 演算法在不同瀏覽器要跑出一樣結果」這個額外風險。
// 無限模式的「隨機」內容一律走 waveHash() 這個純雜湊,同樣不用 Math.random()。

import { ALL_ELEMENTS, type Element } from './elements';
import { createStartPos, pathCount, type PathPos } from './map';

/**
 * 移動類型(參考 Bloons TD 的 flying/camo 分類概念,簡化成互斥的三選一,不是獨立疊加的標記):
 * 'ground' 是預設,大多數怪物都是;'air' 飛在空中(陷阱打不到,只有部分屬性的塔打得到);
 * 'water' 是水路怪(只有非火屬性的塔打得到,呼應五行水克火;出場時路徑會有流水視覺效果)。
 * 這個分類獨立於 Element(五行傷害倍率用),兩者互不影響。
 */
export type MoveType = 'ground' | 'air' | 'water';

/**
 * 怪物特殊能力(2026-07-23 加的):讓「這波該怎麼打」不只看屬性跟移動類型,還要看牠帶什麼能力。
 * 互斥的六選一(含 'none'),不做可疊加的標記組合——組合爆炸對平衡跟 UI 都不划算。
 * - healer  治療兵:定期回復周圍同伴的血,不先解決牠的話周圍怪物打不死
 * - shield  護盾兵:身上有一層獨立的護盾值,要先打穿護盾才會扣本體血量
 * - splitter 分裂怪:死亡時分裂成兩隻小怪(小怪不會再分裂),清場數量會暴增
 * - aura    急行光環:提升周圍同伴的移動速度,自己不快
 * - bomber  爆破兵:漏怪時扣的生命比一般怪多,優先度最高
 */
export type MonsterAbility = 'none' | 'healer' | 'shield' | 'splitter' | 'aura' | 'bomber';

export const ABILITY_NAMES: Record<MonsterAbility, string> = {
  none: '無',
  healer: '治療兵',
  shield: '護盾兵',
  splitter: '分裂怪',
  aura: '急行光環',
  bomber: '爆破兵',
};

export const ABILITY_DESCRIPTIONS: Record<MonsterAbility, string> = {
  none: '',
  healer: '定期回復周圍同伴血量',
  shield: '有一層護盾,要先打穿才會扣血',
  splitter: '死亡時分裂成兩隻小怪',
  aura: '提升周圍同伴的移動速度',
  bomber: '漏掉的話會扣比較多生命',
};

/** 治療兵:每隔這麼多 tick 回復一次,範圍內每隻同伴回復自己最大血量的這個百分比。 */
export const HEALER_INTERVAL_TICKS = 30;
export const HEALER_RANGE_FP = 2600;
export const HEALER_HEAL_PERCENT = 6;

/** 護盾兵:護盾值是自己最大血量的這個百分比。護盾扣完不會再生。 */
export const SHIELD_HP_PERCENT = 60;

/** 分裂怪:死亡時分裂出這麼多隻,每隻繼承最大血量的這個百分比;分裂出來的小怪不會再分裂。 */
export const SPLITTER_CHILD_COUNT = 2;
export const SPLITTER_CHILD_HP_PERCENT = 35;
/** 小怪的賞金是母體的這個百分比,避免分裂怪變成賞金印鈔機。 */
export const SPLITTER_CHILD_BOUNTY_PERCENT = 25;

/** 急行光環:範圍內同伴(不含自己)的移動速度提升這個百分比。 */
export const AURA_RANGE_FP = 2800;
export const AURA_SPEED_BONUS_PERCENT = 30;

/** 爆破兵:漏掉時扣這麼多生命(一般怪是 1)。 */
export const BOMBER_LIVES_COST = 3;

export interface Monster {
  id: number;
  element: Element;
  hp: number;
  maxHp: number;
  speedFp: number;
  bounty: number;
  pos: PathPos;
  /** 這隻怪屬於第幾波(0-based),加碼波判定「整波清光了沒」要用 */
  waveIndex: number;
  /** 首領波的怪(目前只有最後一波),UI 用來畫得比較大隻/加標示,也影響控制類狀態的抗性。 */
  isBoss: boolean;
  /** 移動類型,影響哪些塔打得到、陷阱有沒有效(見 src/sim/towers.ts 的 canTargetMoveType())。 */
  moveType: MoveType;
  /** 特殊能力(見 MonsterAbility)。'none' 代表一般怪。 */
  ability: MonsterAbility;
  /** 護盾兵專用:目前剩餘護盾值,扣完歸零不再生;非護盾兵一律是 0。 */
  shieldHp: number;
  /** 護盾兵專用:護盾上限,純顯示用(畫護盾條要知道比例)。 */
  maxShieldHp: number;
  /** 治療兵專用:距離上次治療過了幾 tick。 */
  ticksSinceHeal: number;
  /** 分裂怪分裂出來的小怪標記為 true,不會再分裂(避免無限分裂)。 */
  isSplitChild: boolean;
  // ---- 元素異常狀態(見 statuses.ts)。用扁平欄位而不是陣列/Map,
  // clone 跟 computeChecksum 的序列化都比較單純,也不會有鍵序問題。
  statusBurnTicks: number;
  /** 灼燒每次跳的傷害(觸發當下那一擊傷害的百分比,見 statuses.ts 的 BURN_DAMAGE_PERCENT)。 */
  statusBurnDamage: number;
  /** 距離上次灼燒跳傷害過了幾 tick。 */
  statusBurnElapsed: number;
  statusChillTicks: number;
  statusEntangleTicks: number;
  statusSunderTicks: number;
}

export interface WaveDef {
  element: Element;
  count: number;
  hp: number;
  speedFp: number;
  bounty: number;
  /** 加碼波(可選):在波次開始後這麼多 tick 內把整波清光,可以拿 bonusGold 額外獎勵。 */
  bonusClearWithinTicks?: number;
  bonusGold?: number;
  /** 首領波(可選):目前只用在最後一波,單隻厚血高賞金的怪當收尾挑戰。 */
  isBoss?: boolean;
  /** 移動類型(可選,不填就是 'ground')。 */
  moveType?: MoveType;
  /** 特殊能力(可選,不填就是 'none')。 */
  ability?: MonsterAbility;
}

export const WAVE_INTERVAL_TICKS = 400; // 20 tick/秒 * 20 秒
export const SPAWN_INTERVAL_TICKS = 20; // 同波怪物間隔 1 秒

// 數值都是先求「能玩」的佔位平衡,真正平衡是 Phase 5 的事。2026-07-16 玩家實測反應金幣
// 累積太快、根本花不完,把賞金整批調降約 30%(呼應同一次調整裡塔/陷阱/圖騰的漲價跟資源建築
// 收入調降,三個方向一起下手,不是單靠其中一個)。
//
// 2026-07-23 加了怪物特殊能力(ability):固定 8 波刻意「由淺入深」逐波引入一種新能力,
// 讓玩家一次只要應付一個新機制,不是一開始就全部混在一起。
export const WAVES: readonly WaveDef[] = [
  // 水路怪:出場時路徑會浮現流水視覺效果(GameScene.ts),只有非火屬性的塔打得到(水克火)。
  { element: 'water', count: 6, hp: 40, speedFp: 60, bounty: 7, moveType: 'water' },
  { element: 'fire', count: 6, hp: 55, speedFp: 65, bounty: 8 },
  // 第 3 波引入護盾兵:數量不多,讓玩家第一次體會「打不動」是因為有護盾,不是塔太弱。
  { element: 'wood', count: 8, hp: 70, speedFp: 60, bounty: 10, ability: 'shield' },
  // 加碼波:血少速度快,限時內清光才拿得到額外金幣,清不完也不會有懲罰。
  {
    element: 'earth',
    count: 5,
    hp: 30,
    speedFp: 90,
    bounty: 6,
    bonusClearWithinTicks: 200,
    bonusGold: 70,
  },
  // 第 5 波引入分裂怪:血量調低一點,因為實際要打的總量是分裂後的兩倍多。
  { element: 'earth', count: 8, hp: 70, speedFp: 55, bounty: 11, ability: 'splitter' },
  // 飛行怪:陷阱打不到,只有土屬性以外的塔打得到(土是純地面系,搆不到天上)。
  { element: 'metal', count: 10, hp: 110, speedFp: 60, bounty: 13, moveType: 'air' },
  // 第 7 波引入治療兵:整波都會互相治療,逼玩家把火力集中而不是平均分散。
  { element: 'fire', count: 12, hp: 130, speedFp: 70, bounty: 15, ability: 'healer' },
  // 最終首領波:單隻厚血慢速的收尾挑戰,賞金給得比較多當作全破獎勵的一部分。
  { element: 'earth', count: 1, hp: 1200, speedFp: 35, bounty: 105, isBoss: true },
];

export function totalWaveTicks(): number {
  return WAVES.length * WAVE_INTERVAL_TICKS;
}

/** 目前是第幾波(1-based),超過最後一波就固定停在最後一波編號。 */
export function currentWaveNumber(tick: number): number {
  return Math.min(Math.floor(tick / WAVE_INTERVAL_TICKS), WAVES.length - 1) + 1;
}

/** 距離下一波開始還有幾個 tick;已經是最後一波的話回傳 null(沒有下一波了)。 */
export function ticksUntilNextWave(tick: number): number | null {
  const nextWaveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
  if (nextWaveIndex >= WAVES.length) return null;
  return nextWaveIndex * WAVE_INTERVAL_TICKS - tick;
}

/** 下一波的波次定義(讓 UI 能提前顯示屬性);沒有下一波就回傳 null。 */
export function upcomingWaveDef(tick: number): WaveDef | null {
  const nextWaveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
  if (nextWaveIndex >= WAVES.length) return null;
  return WAVES[nextWaveIndex];
}

/** 目前這波如果是加碼波,回傳距離時限還剩幾個 tick + 獎勵金額;不是加碼波或已經過時限就回傳 null。 */
export function activeBonusWaveInfo(tick: number): { ticksLeft: number; bonusGold: number } | null {
  const waveIndex = Math.min(Math.floor(tick / WAVE_INTERVAL_TICKS), WAVES.length - 1);
  const wave = WAVES[waveIndex];
  if (wave.bonusClearWithinTicks === undefined || wave.bonusGold === undefined) return null;
  const deadline = waveIndex * WAVE_INTERVAL_TICKS + wave.bonusClearWithinTicks;
  if (tick > deadline) return null;
  return { ticksLeft: deadline - tick, bonusGold: wave.bonusGold };
}

export interface SpawnEvent {
  element: Element;
  hp: number;
  speedFp: number;
  bounty: number;
  pathId: number;
  waveIndex: number;
  isBoss: boolean;
  moveType: MoveType;
  ability: MonsterAbility;
}

/** 純函式:給定 tick,回傳這一 tick 該生出的怪物。同一個 tick 在哪台機器算都是同一個答案。 */
export function getSpawnEventsForTick(tick: number): SpawnEvent[] {
  const events: SpawnEvent[] = [];
  const pathTotal = pathCount();
  for (let i = 0; i < WAVES.length; i++) {
    const wave = WAVES[i];
    const waveStartTick = i * WAVE_INTERVAL_TICKS;
    for (let j = 0; j < wave.count; j++) {
      const spawnTick = waveStartTick + j * SPAWN_INTERVAL_TICKS;
      if (spawnTick === tick) {
        events.push({
          element: wave.element,
          hp: wave.hp,
          speedFp: wave.speedFp,
          bounty: wave.bounty,
          // 同一波怪物輪流分配路徑,逼玩家同時顧好每條路,而不是把火力全堆在一條線上。
          pathId: j % pathTotal,
          waveIndex: i,
          isBoss: wave.isBoss ?? false,
          moveType: wave.moveType ?? 'ground',
          ability: wave.ability ?? 'none',
        });
      }
    }
  }
  return events;
}

export function createMonster(id: number, spawn: SpawnEvent): Monster {
  const shieldHp = spawn.ability === 'shield' ? Math.floor((spawn.hp * SHIELD_HP_PERCENT) / 100) : 0;
  return {
    id,
    element: spawn.element,
    hp: spawn.hp,
    maxHp: spawn.hp,
    speedFp: spawn.speedFp,
    bounty: spawn.bounty,
    pos: createStartPos(spawn.pathId),
    waveIndex: spawn.waveIndex,
    isBoss: spawn.isBoss,
    moveType: spawn.moveType,
    ability: spawn.ability,
    shieldHp,
    maxShieldHp: shieldHp,
    ticksSinceHeal: 0,
    isSplitChild: false,
    statusBurnTicks: 0,
    statusBurnDamage: 0,
    statusBurnElapsed: 0,
    statusChillTicks: 0,
    statusEntangleTicks: 0,
    statusSunderTicks: 0,
  };
}

/**
 * 分裂怪死亡時生出來的小怪:繼承母體的位置/屬性/移動類型,血量/賞金打折,而且
 * `isSplitChild` 標記成 true——小怪自己不會再分裂,避免一隻怪把場面炸成無限指數成長。
 * `childIndex` 只用來讓兩隻小怪的出生位置錯開一點點,不然牠們會完全重疊看起來只有一隻。
 */
export function createSplitChild(id: number, parent: Monster, childIndex: number): Monster {
  const hp = Math.max(1, Math.floor((parent.maxHp * SPLITTER_CHILD_HP_PERCENT) / 100));
  return {
    id,
    element: parent.element,
    hp,
    maxHp: hp,
    speedFp: parent.speedFp,
    bounty: Math.max(1, Math.floor((parent.bounty * SPLITTER_CHILD_BOUNTY_PERCENT) / 100)),
    pos: {
      pathId: parent.pos.pathId,
      segmentIndex: parent.pos.segmentIndex,
      // 往回錯開,不會往前跳(往前等於免費前進,對玩家不公平)。夾在 0 以上避免變成負的。
      distanceIntoSegmentFp: Math.max(0, parent.pos.distanceIntoSegmentFp - childIndex * 250),
    },
    waveIndex: parent.waveIndex,
    isBoss: false,
    moveType: parent.moveType,
    ability: 'none',
    shieldHp: 0,
    maxShieldHp: 0,
    ticksSinceHeal: 0,
    isSplitChild: true,
    statusBurnTicks: 0,
    statusBurnDamage: 0,
    statusBurnElapsed: 0,
    statusChillTicks: 0,
    statusEntangleTicks: 0,
    statusSunderTicks: 0,
  };
}

// ---- 無限模式(2026-07-15 加的):跟上面固定 8 波的 WAVES 完全獨立的另一套生怪規則,
// 沒有終點,難度隨波次持續往上疊,直到守不住(gameOver)為止,不會有 victory。
// 選這個模式的對局在 createInitialState() 就會把 SimulationState.endlessMode 設成 true,
// step() 依這個旗標二選一走這裡的邏輯還是走上面固定的 WAVES 邏輯,兩套互不干擾。

/** 每隔這麼多波(0-based,第 4、9、14...波,也就是每 5 波的最後一波)是首領波。 */
export const ENDLESS_BOSS_INTERVAL = 5;
const ENDLESS_BASE_HP = 50;
const ENDLESS_BASE_SPEED_FP = 60;
const ENDLESS_BASE_BOUNTY = 8; // 2026-07-16 跟著固定模式的賞金調降一起降(約 -30%)
const ENDLESS_WAVE_MONSTER_COUNT_BASE = 8;
/** 每隔幾波,非首領波的隻數 +1(呼應血量/速度「持續變強」的設計,單靠數值成長撐不了太久場面感)。 */
const ENDLESS_MONSTER_COUNT_GROWTH_INTERVAL = 2;
/**
 * 隻數上限。硬限制是 WAVE_INTERVAL_TICKS / SPAWN_INTERVAL_TICKS = 20(超過的話最後幾隻的生怪
 * tick 會落在下一波的時間範圍內,被下一波的排程蓋掉、永遠不會生出來),這裡刻意留緩衝不頂到硬限制。
 */
const ENDLESS_WAVE_MONSTER_COUNT_CAP = 16;
/** 血量/賞金每波 +12%(對第 0 波基準值線性疊加,不封頂——就是要讓怪物「持續變強」)。 */
const ENDLESS_HP_GROWTH_PERCENT = 12;
/** 速度每波 +3%,但封頂在基準值的 160%,避免無限模式後期怪物快到玩家反應不過來/定點數運算異常。 */
const ENDLESS_SPEED_GROWTH_PERCENT = 3;
const ENDLESS_SPEED_GROWTH_CAP_PERCENT = 60;
/**
 * 特殊能力從第幾波開始出現(0-based)。前幾波刻意保持乾淨,讓玩家先熟悉基本節奏,
 * 跟固定模式「由淺入深逐波引入」的設計方向一致。
 */
const ENDLESS_ABILITY_START_WAVE = 3;
/** 非首領波出現特殊能力的機率(百分比,靠 waveHash 決定,不是 Math.random)。 */
const ENDLESS_ABILITY_CHANCE_PERCENT = 45;
/** 無限模式會抽到的能力池(不含 'none','none' 由上面的機率決定)。 */
const ENDLESS_ABILITY_POOL: readonly MonsterAbility[] = ['shield', 'splitter', 'healer', 'aura', 'bomber'];

/**
 * 首領波造型三選一,靠 waveHash 決定(見下面 generateEndlessWave):
 * 'single' 是原本就有的單隻厚血慢速;'group' 是三隻一組的首領小隊,考驗玩家能不能同時分散火力;
 * 'swift' 是血薄速度快的迅捷首領,考驗集火反應速度而不是耐力——三種造型輪流出現避免每次首領波
 * 都是同一套「站著慢慢打」的節奏。
 */
type EndlessBossType = 'single' | 'group' | 'swift';

/**
 * 純函式的決定性雜湊(不是密碼學等級,風格跟 GameScene.ts 的 tileHash() 一致):同樣的
 * (waveIndex, salt) 在任何機器上都算出同一個整數,無限模式的「隨機」生怪內容全靠這個,
 * 不能用 Math.random()(那樣每台機器/每次重播都會兜不起來,違反 lockstep 決定性）。
 */
function waveHash(waveIndex: number, salt: number): number {
  let h = (waveIndex * 374761393 + salt * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

interface EndlessArchetype {
  element: Element;
  moveType: MoveType;
  ability: MonsterAbility;
}

interface EndlessWave {
  archetypes: readonly EndlessArchetype[];
  hp: number;
  speedFp: number;
  bounty: number;
  count: number;
  isBoss: boolean;
  /** 只有 isBoss 為 true 時才有意義,給 UI 顯示不同首領造型的提示用。 */
  bossType?: EndlessBossType;
}

/** 純函式:無限模式第 waveIndex 波(0-based,沒有上限)要生什麼怪,同樣的 waveIndex 到哪都算出同一份結果。 */
function generateEndlessWave(waveIndex: number): EndlessWave {
  const hpGrowthPercent = 100 + waveIndex * ENDLESS_HP_GROWTH_PERCENT;
  const speedGrowthPercent = 100 + Math.min(waveIndex * ENDLESS_SPEED_GROWTH_PERCENT, ENDLESS_SPEED_GROWTH_CAP_PERCENT);
  const hp = Math.floor((ENDLESS_BASE_HP * hpGrowthPercent) / 100);
  const speedFp = Math.floor((ENDLESS_BASE_SPEED_FP * speedGrowthPercent) / 100);
  const bounty = Math.floor((ENDLESS_BASE_BOUNTY * hpGrowthPercent) / 100);

  const isBoss = waveIndex > 0 && (waveIndex + 1) % ENDLESS_BOSS_INTERVAL === 0;
  if (isBoss) {
    const element = ALL_ELEMENTS[waveHash(waveIndex, 1) % ALL_ELEMENTS.length];
    // 首領本身不帶特殊能力——牠已經有血量/體型上的壓迫感,再疊能力會變成單點無解。
    const archetypes: readonly EndlessArchetype[] = [{ element, moveType: 'ground', ability: 'none' }];
    const bossTypeRoll = waveHash(waveIndex, 3) % 3;
    if (bossTypeRoll === 1) {
      // group:三隻一組的首領小隊,單隻血量沒有 single 型誇張,但同時要分散顧三個目標,
      // 總賞金維持跟 single 型同一個量級(除以隻數),不是三倍收入。
      return {
        archetypes,
        hp: hp * 4,
        speedFp,
        bounty: Math.floor((bounty * 10) / 3),
        count: 3,
        isBoss: true,
        bossType: 'group',
      };
    }
    if (bossTypeRoll === 2) {
      // swift:血薄速度快,考驗集火反應速度而不是耐力,賞金維持跟 single 型同一個量級。
      return {
        archetypes,
        hp: hp * 6,
        speedFp: Math.floor(speedFp * 1.3),
        bounty: bounty * 10,
        count: 1,
        isBoss: true,
        bossType: 'swift',
      };
    }
    return {
      archetypes,
      hp: hp * 12, // 首領血量大幅放大,呼應固定模式最終首領波的「單隻厚血」收尾感
      speedFp: Math.floor(speedFp * 0.7), // 首領慢一點,拉長對戰時間(跟固定模式首領波同樣的設計理由)
      bounty: bounty * 10,
      count: 1,
      isBoss: true,
      bossType: 'single',
    };
  }

  // 非首領波:約 1/3 機率混 2 種元素(不是每波都混,保留「單一元素波」的辨識度跟節奏感)。
  const mixCount = waveHash(waveIndex, 2) % 3 === 0 ? 2 : 1;
  const archetypes: EndlessArchetype[] = [];
  for (let i = 0; i < mixCount; i++) {
    const element = ALL_ELEMENTS[waveHash(waveIndex, 10 + i) % ALL_ELEMENTS.length];
    // 各約 10% 機率出現空/水路怪,製造變化,其餘都是一般地面怪。
    const moveRoll = waveHash(waveIndex, 20 + i) % 10;
    const moveType: MoveType = moveRoll === 0 ? 'air' : moveRoll === 1 ? 'water' : 'ground';
    // 特殊能力:前幾波不出現,之後依機率抽一種。同一波混兩種元素時兩邊各自抽,可能不一樣。
    let ability: MonsterAbility = 'none';
    if (waveIndex >= ENDLESS_ABILITY_START_WAVE && waveHash(waveIndex, 30 + i) % 100 < ENDLESS_ABILITY_CHANCE_PERCENT) {
      ability = ENDLESS_ABILITY_POOL[waveHash(waveIndex, 40 + i) % ENDLESS_ABILITY_POOL.length];
    }
    archetypes.push({ element, moveType, ability });
  }

  const count = Math.min(
    ENDLESS_WAVE_MONSTER_COUNT_BASE + Math.floor(waveIndex / ENDLESS_MONSTER_COUNT_GROWTH_INTERVAL),
    ENDLESS_WAVE_MONSTER_COUNT_CAP,
  );

  return { archetypes, hp, speedFp, bounty, count, isBoss: false };
}

/** 無限模式版的 getSpawnEventsForTick——只算「現在這一波」該生什麼,O(1) 不會隨對局拉長而變慢。 */
export function getEndlessSpawnEventsForTick(tick: number): SpawnEvent[] {
  const waveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS);
  const waveStartTick = waveIndex * WAVE_INTERVAL_TICKS;
  const wave = generateEndlessWave(waveIndex);
  const pathTotal = pathCount();
  const events: SpawnEvent[] = [];
  for (let j = 0; j < wave.count; j++) {
    const spawnTick = waveStartTick + j * SPAWN_INTERVAL_TICKS;
    if (spawnTick !== tick) continue;
    const archetype = wave.archetypes[j % wave.archetypes.length];
    events.push({
      element: archetype.element,
      hp: wave.hp,
      speedFp: wave.speedFp,
      bounty: wave.bounty,
      pathId: j % pathTotal,
      waveIndex,
      isBoss: wave.isBoss,
      moveType: archetype.moveType,
      ability: archetype.ability,
    });
  }
  return events;
}

/** 無限模式版的「目前第幾波」,不像固定模式封頂在 WAVES.length,永遠照實際 tick 往上算。 */
export function currentWaveNumberEndless(tick: number): number {
  return Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
}

/** 無限模式版的「距離下一波還有幾個 tick」,永遠有下一波,不會回傳 null。 */
export function ticksUntilNextWaveEndless(tick: number): number {
  const nextWaveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
  return nextWaveIndex * WAVE_INTERVAL_TICKS - tick;
}

/** 無限模式版的下一波預覽(給 HUD 顯示用):只給主要元素/是否首領波/主要能力,不細列混波的第二種元素。 */
export function upcomingWaveDefEndless(
  tick: number,
): { element: Element; isBoss: boolean; bossType?: EndlessBossType; ability: MonsterAbility } {
  const nextWaveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
  const wave = generateEndlessWave(nextWaveIndex);
  return {
    element: wave.archetypes[0].element,
    isBoss: wave.isBoss,
    bossType: wave.bossType,
    ability: wave.archetypes[0].ability,
  };
}
