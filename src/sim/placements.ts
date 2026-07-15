// 非攻擊型放置物:陷阱(踩到會減速,只能蓋在路徑格)、資源建築(定期產生被動金幣,
// 只能蓋在非路徑格,規則跟塔一樣)。跟塔一樣不做防作弊驗證,不合法的蓋一律安全忽略。
// 數值是先求「能玩」的佔位平衡,真正調數值是 Phase 5 的事(參考 towers.ts 的既有慣例)。

import type { PlayerId } from '../net/protocol';

export interface Trap {
  id: number;
  x: number;
  y: number;
  ownerId: PlayerId;
}

export const TRAP_COST = 30;
/** 怪物只要站在陷阱格上,這個 tick 的移動速度打這個折扣(百分比)。持續生效,不是只觸發一次就消失。 */
export const TRAP_SLOW_PERCENT = 50;

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
