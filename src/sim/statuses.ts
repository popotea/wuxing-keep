// 元素異常狀態(2026-07-23 加的):塔攻擊時有機率對怪物附加一個依「塔的屬性」決定的負面狀態,
// 讓「選哪個屬性」從單純的傷害倍率比較,變成還要考慮想要哪種戰術效果。
//
// 決定性守則:觸發與否**不能用 Math.random()**,改用 (tick, towerId, monsterId) 的純雜湊
// (statusRoll),同樣的輸入在任何機器上都算出同一個結果;所有持續時間/傷害都是整數 tick/整數傷害。

import type { Element } from './elements';

/**
 * 五種持續型狀態,各對應一個塔屬性(擊退是瞬間效果、不在這裡,見 STATUS_BY_ELEMENT 的 'knockback')。
 * 刻意讓五種效果的「作用面」都不一樣(扣血 / 減速 / 定身 / 增傷 / 位移),不是同一種效果的強弱版本。
 */
export type StatusKind = 'burn' | 'chill' | 'entangle' | 'sunder' | 'knockback';

export const STATUS_NAMES: Record<StatusKind, string> = {
  burn: '灼燒',
  chill: '冰緩',
  entangle: '纏繞',
  sunder: '破甲',
  knockback: '擊退',
};

export const STATUS_DESCRIPTIONS: Record<StatusKind, string> = {
  burn: '持續扣血,無視移動類型',
  chill: '移動速度大幅下降',
  entangle: '短時間完全定身',
  sunder: '受到的所有傷害增加',
  knockback: '立刻沿路徑往回推',
};

/** 哪個屬性的塔會附加哪種狀態。五種屬性各自獨佔一種,不重複。 */
export const STATUS_BY_ELEMENT: Record<Element, StatusKind> = {
  fire: 'burn',
  water: 'chill',
  wood: 'entangle',
  metal: 'sunder',
  earth: 'knockback',
};

/** 每次攻擊觸發狀態的機率(百分比)。塔等級越高越容易觸發,見 statusChancePercent()。 */
export const STATUS_BASE_CHANCE_PERCENT = 18;
/** 每升一級額外增加的觸發機率(百分比點數)。 */
export const STATUS_CHANCE_PER_LEVEL = 4;

/** 灼燒:每隔這麼多 tick 扣一次血,持續 BURN_DURATION_TICKS。 */
export const BURN_INTERVAL_TICKS = 10;
export const BURN_DURATION_TICKS = 60;
/** 每次跳的傷害是觸發當下那一擊傷害的這個百分比(整數運算,至少 1)。 */
export const BURN_DAMAGE_PERCENT = 25;

/** 冰緩:移動速度打這個折扣(百分比點數),持續 CHILL_DURATION_TICKS。 */
export const CHILL_SLOW_PERCENT = 40;
export const CHILL_DURATION_TICKS = 60;

/** 纏繞:完全定身(速度歸零)。時間刻意很短——完全停住比單純減速強太多。 */
export const ENTANGLE_DURATION_TICKS = 22;

/** 破甲:期間受到的所有傷害增加這個百分比。 */
export const SUNDER_DAMAGE_BONUS_PERCENT = 30;
export const SUNDER_DURATION_TICKS = 80;

/** 擊退:瞬間沿路徑往回推這麼多定點數距離(1000 = 1 格)。不是持續狀態,沒有持續時間。 */
export const KNOCKBACK_DISTANCE_FP = 900;

/** 首領怪對控制類狀態(纏繞/冰緩/擊退)的抗性:持續時間/距離打這個折扣,避免首領被鎖死。 */
export const BOSS_CONTROL_RESIST_PERCENT = 40;

/**
 * 決定性的觸發判定:同樣的 (tick, towerId, monsterId) 在任何機器上都算出同一個 0..99 的數字。
 * 風格跟 monsters.ts 的 waveHash()、GameScene.ts 的 tileHash() 一致——這類「看起來隨機但其實
 * 是純函式」的判定是 lockstep 底下唯一可以用的隨機來源。
 */
export function statusRoll(tick: number, towerId: number, monsterId: number): number {
  let h = (tick * 2654435761 + towerId * 40503 + monsterId * 374761393) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) % 100;
}

export function statusChancePercent(towerLevel: number): number {
  return STATUS_BASE_CHANCE_PERCENT + (towerLevel - 1) * STATUS_CHANCE_PER_LEVEL;
}

/** 首領怪的控制減免:整數運算,至少留 1 tick / 1 單位,不會因為 floor 變成完全免疫。 */
export function applyBossResist(value: number, isBoss: boolean): number {
  if (!isBoss) return value;
  return Math.max(1, Math.floor((value * (100 - BOSS_CONTROL_RESIST_PERCENT)) / 100));
}
