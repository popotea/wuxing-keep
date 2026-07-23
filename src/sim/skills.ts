// 玩家主動技能(2026-07-23 加的):塔防原本只有「蓋好就等」的被動節奏,主動技能讓玩家在
// 危急時有臨場救援的手段,多人時還能分工(一個人專門負責定身、一個人負責爆發傷害)。
//
// 設計原則:
// - **不花金幣,只有冷卻**——金幣已經是建塔/升級的資源,技能再吃金幣會變成「有錢才有技能」,
//   反而讓落後的玩家更沒有翻盤手段。冷卻是每個人各自獨立的(不是團隊共用一份)。
// - **每個人都能施放,不分誰的塔/誰的路徑**(跟升級、集火策略、呼叫下一波同一套慣例)。
// - **只做正面互助,不做互相陷害**(既有原則):技能只會傷害怪物、增益我方,沒有任何一個
//   技能可以影響隊友的建築或資源。

import type { PlayerId } from '../net/protocol';

export type SkillId = 'meteor' | 'frost' | 'warcry';

/** 固定順序——`SimulationState.skillCooldowns` 是照這個順序存的數字陣列,不能隨意調換。 */
export const SKILL_IDS: readonly SkillId[] = ['meteor', 'frost', 'warcry'];

export interface SkillDef {
  id: SkillId;
  name: string;
  description: string;
  /** 施放後要等這麼多 tick 才能再放(20 tick = 1 秒)。 */
  cooldownTicks: number;
  /** 作用範圍(定點數,1000 = 1 格),以點擊的格子為圓心。 */
  rangeFp: number;
}

export const SKILL_DEFS: Record<SkillId, SkillDef> = {
  // 隕石:純爆發傷害,冷卻最長。傷害是固定值不隨塔等級成長——技能定位是「救急」,
  // 不是主要輸出來源,不能讓玩家靠狂點技能取代蓋塔。
  meteor: {
    id: 'meteor',
    name: '隕石轟炸',
    description: '對範圍內所有怪物造成大量傷害(無視移動類型)',
    cooldownTicks: 900,
    rangeFp: 3200,
  },
  // 寒冰:範圍控場,不造成傷害。用來擋住一波快要漏掉的怪,爭取塔的輸出時間。
  frost: {
    id: 'frost',
    name: '寒冰風暴',
    description: '範圍內所有怪物定身一段時間,之後還會殘留冰緩',
    cooldownTicks: 700,
    rangeFp: 3600,
  },
  // 戰吼:增益我方塔,不分誰蓋的塔都吃得到(呼應「相生鄰接/圖騰不分陣營」的既有慣例)。
  warcry: {
    id: 'warcry',
    name: '戰吼',
    description: '範圍內所有塔大幅提升攻速一段時間(不分誰蓋的)',
    cooldownTicks: 600,
    rangeFp: 4000,
  },
};

/** 隕石對範圍內每隻怪造成的傷害。走 towers.ts 的 dealDamage(),所以一樣吃破甲增傷/被護盾吸收。 */
export const METEOR_DAMAGE = 260;

/** 寒冰:先完全定身這麼多 tick,結束後殘留的冰緩再持續 FROST_CHILL_TICKS。 */
export const FROST_ENTANGLE_TICKS = 40;
export const FROST_CHILL_TICKS = 100;

/** 戰吼:範圍內的塔獲得這麼多 tick 的攻速 buff(折扣幅度見 towers.ts 的 WARCRY_COOLDOWN_PERCENT)。 */
export const WARCRY_DURATION_TICKS = 200;

export function isSkillId(v: unknown): v is SkillId {
  return v === 'meteor' || v === 'frost' || v === 'warcry';
}

/** 新玩家的初始冷卻表:全部 0(開局就能用)。長度固定等於 SKILL_IDS.length。 */
export function createSkillCooldowns(): number[] {
  return SKILL_IDS.map(() => 0);
}

/**
 * 取某個玩家某個技能還剩幾 tick 冷卻。找不到玩家(例如觀戰/資料不同步)一律當 0,
 * 跟其他「不合法就安全處理」的慣例一致,不丟例外。
 */
export function skillCooldownRemaining(
  cooldowns: Record<PlayerId, number[]>,
  playerId: PlayerId,
  skillId: SkillId,
): number {
  const idx = SKILL_IDS.indexOf(skillId);
  if (idx === -1) return 0;
  return cooldowns[playerId]?.[idx] ?? 0;
}
