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

/** 隨機英雄選擇 UI 顯示用的角色名(參考 WC3 TD 的手塔風味),不影響任何數值判定。 */
export const TOWER_CHARACTER_NAMES: Record<Element, string> = {
  metal: '黃金衛士',
  wood: '森林游俠',
  water: '碧波法師',
  fire: '烈焰武士',
  earth: '磐石守衛',
};

export const MAX_TOWER_LEVEL = 5;

/**
 * 升級分岐(參考 WC3 TD 手塔技能):1~2 級是共通的線性升級,到 UPGRADE_PATH_LEVEL(3 級)
 * 必須選一條路線,之後(3~5 級)都沿著這條路線走,不能反悔。
 * - burst(單體強化):傷害比原本線性更陡(見 effectiveDamage),沒有範圍效果。
 * - splash(範圍擴散):傷害維持原本線性(沒有額外加成),但攻擊會波及主目標旁邊的怪物(見 tryAttack)。
 */
export type UpgradePath = 'none' | 'burst' | 'splash';
export const UPGRADE_PATH_LEVEL = 3;
export const UPGRADE_PATH_NAMES: Record<UpgradePath, string> = {
  none: '尚未選擇',
  burst: '路線:單體強化',
  splash: '路線:範圍擴散',
};
/** 分岐後,burst 路線的傷害是原本線性公式的這個百分比(150 = 1.5 倍)。 */
const BURST_DAMAGE_PERCENT = 150;
/** 分岐後,splash 路線攻擊會波及主目標這個定點數距離內的其他怪物,傷害打這個百分比折扣。 */
const SPLASH_RANGE_FP = 700;
const SPLASH_DAMAGE_PERCENT = 50;

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
  /** 升級分岐路線,新蓋的塔是 'none',升到 UPGRADE_PATH_LEVEL 那一級才會定案、之後不能改。 */
  upgradePath: UpgradePath;
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

/**
 * 1~2 級(或還沒選路線前)是線性倍增;到 UPGRADE_PATH_LEVEL 選了 'burst' 路線後,傷害
 * 比線性更陡(BURST_DAMAGE_PERCENT);選 'splash' 路線則維持線性不額外加成,因為傷害輸出
 * 靠 tryAttack 的範圍波及效果拿,不是靠單體數字堆疊。範圍/冷卻留給之後平衡調整。
 */
function effectiveDamage(tower: Tower): number {
  const def = TOWER_DEFS[tower.element];
  const base = def.damage * tower.level;
  if (tower.level >= UPGRADE_PATH_LEVEL && tower.upgradePath === 'burst') {
    return Math.floor((base * BURST_DAMAGE_PERCENT) / 100);
  }
  return base;
}

export interface TowerStats {
  damage: number;
  rangeFp: number;
  cooldownTicks: number;
  upgradeCost: number | null;
  sellValue: number;
  upgradePath: UpgradePath;
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
    upgradePath: tower.upgradePath,
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
 * 回傳這次攻擊產生的所有事件給 UI 顯示飄動傷害數字用(通常 1 個,splash 路線可能多個);
 * 沒打中回傳空陣列。
 */
export function tryAttack(tower: Tower, monsters: readonly Monster[]): CombatEvent[] {
  const def = TOWER_DEFS[tower.element];
  tower.ticksSinceLastAttack += 1;
  if (tower.ticksSinceLastAttack < def.cooldownTicks) return [];
  const target = findTarget(monsters, tower, def);
  if (!target) return [];
  tower.ticksSinceLastAttack = 0;
  const damage = applyElementalDamage(effectiveDamage(tower), tower.element, target.element);
  target.hp -= damage;
  const targetPosFp = worldPositionFp(target.pos);
  const events: CombatEvent[] = [{ monsterId: target.id, xFp: targetPosFp.xFp, yFp: targetPosFp.yFp, damage }];

  // splash 路線:主目標旁邊 SPLASH_RANGE_FP 定點數距離內的其他怪物也各自挨一下折扣傷害
  // (一樣用距離平方比較,不用 sqrt,決定性不受影響)。
  if (tower.level >= UPGRADE_PATH_LEVEL && tower.upgradePath === 'splash') {
    const splashRangeSq = SPLASH_RANGE_FP * SPLASH_RANGE_FP;
    for (const m of monsters) {
      if (m.id === target.id) continue;
      const { xFp, yFp } = worldPositionFp(m.pos);
      const dx = targetPosFp.xFp - xFp;
      const dy = targetPosFp.yFp - yFp;
      if (dx * dx + dy * dy > splashRangeSq) continue;
      const splashDamage = applyElementalDamage(
        Math.floor((effectiveDamage(tower) * SPLASH_DAMAGE_PERCENT) / 100),
        tower.element,
        m.element,
      );
      m.hp -= splashDamage;
      events.push({ monsterId: m.id, xFp, yFp, damage: splashDamage });
    }
  }

  return events;
}
