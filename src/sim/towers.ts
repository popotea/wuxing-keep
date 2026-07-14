// 塔:五行各一種基礎塔,攻擊判定全部用整數距離平方比較,不用 sqrt/float。

import { applyElementalDamage, type Element } from './elements';
import { FP_SCALE, remainingDistanceFp, worldPositionFp } from './map';
import type { Monster } from './monsters';
import type { PlayerId } from '../net/protocol';

export interface TowerDef {
  element: Element;
  cost: number;
  damage: number;
  rangeFp: number;
  cooldownTicks: number;
}

// 佔位數值,真正平衡是 Phase 5 的事。
export const TOWER_DEFS: Record<Element, TowerDef> = {
  metal: { element: 'metal', cost: 50, damage: 14, rangeFp: 2300, cooldownTicks: 22 },
  wood: { element: 'wood', cost: 50, damage: 6, rangeFp: 2800, cooldownTicks: 12 },
  earth: { element: 'earth', cost: 50, damage: 10, rangeFp: 2200, cooldownTicks: 18 },
  water: { element: 'water', cost: 50, damage: 8, rangeFp: 2500, cooldownTicks: 16 },
  fire: { element: 'fire', cost: 50, damage: 12, rangeFp: 2000, cooldownTicks: 20 },
};

export const MAX_TOWER_LEVEL = 5;

/** 集火策略:first=打最前面(離出口最近,原本唯一的行為)、lowest_hp=打血量最少、highest_hp=打血量最多。 */
export type TargetStrategy = 'first' | 'lowest_hp' | 'highest_hp';
export const TARGET_STRATEGIES: readonly TargetStrategy[] = ['first', 'lowest_hp', 'highest_hp'];

export interface Tower {
  id: number;
  element: Element;
  x: number;
  y: number;
  level: number;
  ticksSinceLastAttack: number;
  /** 誰蓋的這座塔——團隊模式金幣各自獨立,賣塔只有本人能賣,但升級任何人都能幫忙出錢。 */
  ownerId: PlayerId;
  /** 集火策略,跟升級一樣不分誰的塔、任何隊友都能改,新蓋的塔預設 'first'。 */
  targetStrategy: TargetStrategy;
}

/** 升級花費:每一級都用原始建造價當漲幅單位,越高級越貴。已滿級回傳 null。 */
export function upgradeCost(tower: Tower): number | null {
  if (tower.level >= MAX_TOWER_LEVEL) return null;
  return TOWER_DEFS[tower.element].cost * tower.level;
}

/** 賣出可以拿回的金幣;跟 simulation.ts 的 applySellTower 共用同一個公式,避免兩邊算法各改各的漂掉。 */
export function sellValue(tower: Tower): number {
  return Math.floor(TOWER_DEFS[tower.element].cost / 2);
}

/** 初版先只讓等級影響傷害(線性倍增),範圍/冷卻留給之後平衡調整。 */
function effectiveDamage(tower: Tower): number {
  return TOWER_DEFS[tower.element].damage * tower.level;
}

export interface TowerStats {
  damage: number;
  rangeFp: number;
  cooldownTicks: number;
  upgradeCost: number | null;
  sellValue: number;
}

/** 給 UI 顯示用(WC3 式選取面板):這座塔目前的實際數值(已套用等級加成)+ 升級/賣出的花費。 */
export function describeTower(tower: Tower): TowerStats {
  const def = TOWER_DEFS[tower.element];
  return {
    damage: effectiveDamage(tower),
    rangeFp: def.rangeFp,
    cooldownTicks: def.cooldownTicks,
    upgradeCost: upgradeCost(tower),
    sellValue: sellValue(tower),
  };
}

// 現在地圖有多條路徑,segmentIndex/distanceIntoSegmentFp 只在同一條路徑內才有可比性,
// 改用「剩餘距離」這種跨路徑通用的絕對單位來比較誰比較接近終點。
function isFurtherAlongPath(a: Monster, b: Monster): boolean {
  const remainingA = remainingDistanceFp(a.pos);
  const remainingB = remainingDistanceFp(b.pos);
  if (remainingA !== remainingB) return remainingA < remainingB;
  return a.id < b.id; // 決定性 tie-break,避免兩隻怪剛好並排時各機器選到不同目標
}

/** candidate 是否比 current 更符合這個策略——所有分支都用 monster.id 當決定性 tie-break。 */
function isBetterTarget(strategy: TargetStrategy, candidate: Monster, current: Monster): boolean {
  if (strategy === 'lowest_hp') {
    if (candidate.hp !== current.hp) return candidate.hp < current.hp;
    return candidate.id < current.id;
  }
  if (strategy === 'highest_hp') {
    if (candidate.hp !== current.hp) return candidate.hp > current.hp;
    return candidate.id < current.id;
  }
  return isFurtherAlongPath(candidate, current); // 'first':classic TD 的「打最前面」
}

/** 範圍內依塔的集火策略選一個目標(預設 first=最靠近終點)。 */
function findTarget(monsters: readonly Monster[], tower: Tower, def: TowerDef): Monster | null {
  const towerXFp = tower.x * FP_SCALE;
  const towerYFp = tower.y * FP_SCALE;
  const rangeSq = def.rangeFp * def.rangeFp;
  let best: Monster | null = null;
  for (const m of monsters) {
    const { xFp, yFp } = worldPositionFp(m.pos);
    const dx = towerXFp - xFp;
    const dy = towerYFp - yFp;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;
    if (!best || isBetterTarget(tower.targetStrategy, m, best)) best = m;
  }
  return best;
}

export interface CombatEvent {
  monsterId: number;
  xFp: number;
  yFp: number;
  damage: number;
}

/**
 * 讓一座塔嘗試攻擊一次。有打中就直接扣目標血量(呼叫端傳進來的 monster 物件會被修改),
 * 並回傳這次攻擊的事件給 UI 顯示飄動傷害數字用;沒打中回傳 null。
 */
export function tryAttack(tower: Tower, monsters: readonly Monster[]): CombatEvent | null {
  const def = TOWER_DEFS[tower.element];
  tower.ticksSinceLastAttack += 1;
  if (tower.ticksSinceLastAttack < def.cooldownTicks) return null;
  const target = findTarget(monsters, tower, def);
  if (!target) return null;
  tower.ticksSinceLastAttack = 0;
  const damage = applyElementalDamage(effectiveDamage(tower), tower.element, target.element);
  target.hp -= damage;
  const { xFp, yFp } = worldPositionFp(target.pos);
  return { monsterId: target.id, xFp, yFp, damage };
}
