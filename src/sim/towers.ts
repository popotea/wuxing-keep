// 塔:五行各一種基礎塔,攻擊判定全部用整數距離平方比較,不用 sqrt/float。

import { applyElementalDamage, type Element } from './elements';
import { FP_SCALE, remainingDistanceFp, worldPositionFp } from './map';
import type { Monster } from './monsters';

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

export interface Tower {
  id: number;
  element: Element;
  x: number;
  y: number;
  level: number;
  ticksSinceLastAttack: number;
}

/** 升級花費:每一級都用原始建造價當漲幅單位,越高級越貴。已滿級回傳 null。 */
export function upgradeCost(tower: Tower): number | null {
  if (tower.level >= MAX_TOWER_LEVEL) return null;
  return TOWER_DEFS[tower.element].cost * tower.level;
}

/** 初版先只讓等級影響傷害(線性倍增),範圍/冷卻留給之後平衡調整。 */
function effectiveDamage(tower: Tower): number {
  return TOWER_DEFS[tower.element].damage * tower.level;
}

// 現在地圖有多條路徑,segmentIndex/distanceIntoSegmentFp 只在同一條路徑內才有可比性,
// 改用「剩餘距離」這種跨路徑通用的絕對單位來比較誰比較接近終點。
function isFurtherAlongPath(a: Monster, b: Monster): boolean {
  const remainingA = remainingDistanceFp(a.pos);
  const remainingB = remainingDistanceFp(b.pos);
  if (remainingA !== remainingB) return remainingA < remainingB;
  return a.id < b.id; // 決定性 tie-break,避免兩隻怪剛好並排時各機器選到不同目標
}

/** 範圍內選「最靠近終點」的怪物當目標(classic TD 的 first 打法)。 */
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
    if (!best || isFurtherAlongPath(m, best)) best = m;
  }
  return best;
}

/** 讓一座塔嘗試攻擊一次。有打中就直接扣目標血量(呼叫端傳進來的 monster 物件會被修改)。 */
export function tryAttack(tower: Tower, monsters: readonly Monster[]): void {
  const def = TOWER_DEFS[tower.element];
  tower.ticksSinceLastAttack += 1;
  if (tower.ticksSinceLastAttack < def.cooldownTicks) return;
  const target = findTarget(monsters, tower, def);
  if (!target) return;
  tower.ticksSinceLastAttack = 0;
  target.hp -= applyElementalDamage(effectiveDamage(tower), tower.element, target.element);
}
