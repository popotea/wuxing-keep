// 非攻擊型放置物:陷阱(踩到會減速,只能蓋在路徑格)、資源建築(定期產生被動金幣,
// 只能蓋在非路徑格,規則跟塔一樣)。跟塔一樣不做防作弊驗證,不合法的蓋一律安全忽略。
// 數值是先求「能玩」的佔位平衡,真正調數值是 Phase 5 的事(參考 towers.ts 的既有慣例)。

import type { PlayerId } from '../net/protocol';

export interface Trap {
  id: number;
  x: number;
  y: number;
  ownerId: PlayerId;
  /** 陷阱等級,新蓋是 1,封頂 MAX_TRAP_LEVEL——只加強減速幅度,不像塔有分岐路線,故意保持單純。 */
  level: number;
}

export const TRAP_COST = 40; // 2026-07-16 從 30 調漲(呼應賞金調降,見 monsters.ts 的 WAVES 註解)
export const MAX_TRAP_LEVEL = 3;
/**
 * 怪物只要站在陷阱格上,這個 tick 的移動速度打這個折扣(百分比,依陷阱等級查表)。持續生效,
 * 不是只觸發一次就消失(v1 刻意不做「用幾次就壞掉」,升級只影響減速幅度)。
 */
export const TRAP_SLOW_PERCENT_BY_LEVEL: Record<number, number> = { 1: 50, 2: 65, 3: 80 };

/** 陷阱升級花費,跟塔的升級公式(cost * level)同一套慣例;已經封頂回傳 null。 */
export function trapUpgradeCost(trap: Trap): number | null {
  if (trap.level >= MAX_TRAP_LEVEL) return null;
  return TRAP_COST * trap.level;
}

// ---- 拆除退款(2026-07-24 加的,原本蓋錯只能認了;資源建築有座數上限後蓋錯=永久佔名額)----
// 跟賣塔同一套慣例:退基礎造價的一半,升級投入不退;拆除限本人(見 simulation.ts)。

export function trapSellValue(): number {
  return Math.floor(TRAP_COST / 2);
}

export function resourceBuildingSellValue(): number {
  return Math.floor(RESOURCE_BUILDING_COST / 2);
}

export function runeTotemSellValue(): number {
  return Math.floor(RUNE_TOTEM_COST / 2);
}

export interface ResourceBuilding {
  id: number;
  x: number;
  y: number;
  ownerId: PlayerId;
  ticksSinceLastIncome: number;
}

// 2026-07-16 玩家實測反應金幣累積太快花不完,把資源建築的被動收入調弱(15 金幣/10 秒
// -> 10 金幣/15 秒)+ 順便漲一點建造成本,呼應同一次調整裡賞金調降、塔/陷阱/圖騰漲價
// (見 monsters.ts 的 WAVES 註解)。**2026-07-20 發現調過頭**:算過一輪 8 波(3200 tick)
// 的總回本——開局第一 tick 就蓋,10/300 這個速率整場下來只回得了 100 金幣,扣掉 90 成本
// 淨賺 10,等於白白讓一格塔的攻擊力空掉 8 波只換 10 金幣,根本不值得蓋,變成陷阱選項。
// 調成 12/250(整場回得了 144,淨賺 54),雖然還是比原本 15/200 弱(調弱的初衷維持),
// 但至少蓋了不會虧,回本期落在中期(約第 5 波)還算合理。
export const RESOURCE_BUILDING_COST = 90;
export const RESOURCE_BUILDING_INCOME = 12;
export const RESOURCE_BUILDING_INTERVAL_TICKS = 250; // 20 tick/秒 * 12.5 秒
/**
 * 每位玩家的資源建築座數上限(2026-07-23 加的)。原本不設限,玩家實測反應蓋一排就能快速
 * 補資金,平衡整個歪掉——尤其無限模式對局時間沒上限,被動收入隨「座數 x 時間」線性放大。
 * 取「每位玩家」而不是「全隊共用」:收入本來就只入 ownerId 自己的帳(金幣每人獨立),
 * 而且全隊共用配額會出現「先蓋先贏、隊友互佔名額」的負面互動,違反「只做正面互助」原則。
 * 3 座封頂 = 每 12.5 秒最多 +36 金幣,固定模式影響溫和,合作分工「有人專職經濟」仍可行。
 */
export const MAX_RESOURCE_BUILDINGS_PER_PLAYER = 3;

/**
 * 符文圖騰:純支援型建築,自己不攻擊,範圍內的塔(不分誰的塔)會得到加成,規則跟塔/
 * 資源建築一樣蓋在非路徑格。跟第二種組合玩法(五行相生鄰接加成,見 towers.ts 的
 * hasGeneratingNeighbor())是互補關係:相生是「塔跟塔之間」的組合,圖騰是「塔跟支援建築
 * 之間」的組合,兩者可以疊加、不衝突。
 *
 * **進階版圖騰**(2026-07-16 加的,呼應塔的分岐升級概念):新蓋的圖騰是 1 級(基礎版,固定
 * `RUNE_TOTEM_DAMAGE_BONUS_PERCENT` 攻擊力加成,沒有分岐);花錢升到 `MAX_RUNE_TOTEM_LEVEL`
 * (2 級)那一次必須二選一定案、之後不能改(跟塔的 `UPGRADE_PATH_LEVEL` 同一套慣例)——
 * `damage`(強化圖騰)把攻擊力加成加重到 `RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED`;
 * `haste`(疾風圖騰)整個換掉,改給範圍內的塔攻速加成(`RUNE_TOTEM_HASTE_PERCENT`,冷卻時間
 * 打折),兩者互斥、不會同時疊加在同一座圖騰上(但一座強化圖騰跟一座疾風圖騰可以同時存在,
 * 各自的效果分開套用在各自範圍內的塔——見 towers.ts 的 `nearbyTotemEffect()`)。
 */
export interface RuneTotem {
  id: number;
  x: number;
  y: number;
  ownerId: PlayerId;
  /** 圖騰等級,新蓋是 1(基礎版),封頂 MAX_RUNE_TOTEM_LEVEL。 */
  level: number;
  /** 升到 MAX_RUNE_TOTEM_LEVEL 那一次才會定案、之後不能改;之前都是 'none'。 */
  upgradePath: 'none' | 'damage' | 'haste';
}

export const RUNE_TOTEM_COST = 150; // 2026-07-16 從 120 調漲(呼應賞金調降,見 monsters.ts 的 WAVES 註解)
/** 範圍(定點數),比大多數塔的攻擊範圍再大一點,才能真的罩住一小群塔,不是只罩到自己那格。 */
export const RUNE_TOTEM_RANGE_FP = 2600;
/** 基礎版(1 級,還沒分歧)的攻擊力加成百分比。 */
export const RUNE_TOTEM_DAMAGE_BONUS_PERCENT = 20;
export const MAX_RUNE_TOTEM_LEVEL = 2;
export const RUNE_TOTEM_UPGRADE_COST = 200;
/** 'damage' 分歧路線加重過的攻擊力加成(取代基礎版的 20%)。 */
export const RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED = 35;
/** 'haste' 分歧路線的攻速加成(冷卻時間打折,不是攻擊力)。 */
export const RUNE_TOTEM_HASTE_PERCENT = 15;
