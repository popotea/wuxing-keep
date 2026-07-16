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

export const TRAP_COST = 30;
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

export interface ResourceBuilding {
  id: number;
  x: number;
  y: number;
  ownerId: PlayerId;
  ticksSinceLastIncome: number;
}

export const RESOURCE_BUILDING_COST = 80;
export const RESOURCE_BUILDING_INCOME = 15;
export const RESOURCE_BUILDING_INTERVAL_TICKS = 200; // 20 tick/秒 * 10 秒

/**
 * 符文圖騰:純支援型建築,自己不攻擊,範圍內的塔(不分誰的塔)攻擊力都會提升,規則跟塔/
 * 資源建築一樣蓋在非路徑格。故意不做等級(跟資源建築一樣單純,先求「組合玩法」的架構成立,
 * 之後真的要加分岐/升級再說)。跟第二種組合玩法(五行相生鄰接加成,見 towers.ts 的
 * hasGeneratingNeighbor())是互補關係:相生是「塔跟塔之間」的組合,圖騰是「塔跟支援建築
 * 之間」的組合,兩者可以疊加、不衝突。
 */
export interface RuneTotem {
  id: number;
  x: number;
  y: number;
  ownerId: PlayerId;
}

export const RUNE_TOTEM_COST = 120;
/** 範圍(定點數),比大多數塔的攻擊範圍再大一點,才能真的罩住一小群塔,不是只罩到自己那格。 */
export const RUNE_TOTEM_RANGE_FP = 2600;
/** 範圍內的塔攻擊力提升這個百分比(20 = +20%),跟塔的分岐路線/相生加成可以疊加。 */
export const RUNE_TOTEM_DAMAGE_BONUS_PERCENT = 20;
