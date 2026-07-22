// 塔:五行各一種基礎塔,攻擊判定全部用整數距離平方比較,不用 sqrt/float。

import { applyDualElementalDamage, applyElementalDamage, GENERATED_BY, type Element } from './elements';
import { FP_SCALE, remainingDistanceFp, worldPositionFp } from './map';
import type { Monster, MoveType } from './monsters';
import {
  MAX_RUNE_TOTEM_LEVEL,
  RUNE_TOTEM_DAMAGE_BONUS_PERCENT,
  RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED,
  RUNE_TOTEM_HASTE_PERCENT,
  RUNE_TOTEM_RANGE_FP,
  type RuneTotem,
} from './placements';
import type { PlayerId } from '../net/protocol';

/**
 * 移動類型限制(參考 Bloons TD 的 flying/camo 概念):'ground' 怪任何塔都打得到;
 * 'air' 怪土屬性打不到(土是純地面系,搆不到天上);'water' 怪火屬性打不到
 * (呼應五行水克火,火遇水熄滅)。刻意讓每種特殊類型都還有 4/5 屬性打得到,
 * 避免玩家選到「完全打不到某種怪」的屬性組合就卡死。
 */
export function canTargetMoveType(element: Element, moveType: MoveType): boolean {
  if (moveType === 'air') return element !== 'earth';
  if (moveType === 'water') return element !== 'fire';
  return true;
}

/**
 * 雙屬性塔(Tower.secondElement)的移動類型判定:只要兩個屬性其中一個打得到就算打得到(OR,
 * 不是 AND)——只有土/火個別各被 1 種移動類型擋住,而且擋的不是同一種(土擋空、火擋水),
 * 所以雙屬性塔任兩個屬性組合起來都不會真的被完全擋死,呼應「沒有致命對位」的設計方向
 * (跟 elements.ts 的 bestElementRelation 同一個精神,只是套用在移動類型而不是傷害倍率)。
 */
export function canDualTargetMoveType(e1: Element, e2: Element, moveType: MoveType): boolean {
  return canTargetMoveType(e1, moveType) || canTargetMoveType(e2, moveType);
}

export interface TowerDef {
  element: Element;
  cost: number;
  damage: number;
  rangeFp: number;
  cooldownTicks: number;
}

// 佔位數值,真正平衡是 Phase 5 的事。cost 2026-07-16 從 50 調漲到 70(呼應同一次調整裡
// 賞金調降、資源建築收入調弱,見 monsters.ts 的 WAVES 註解)——upgradeCost 公式是
// cost * level,漲 cost 連帶讓升級也跟著等比例變貴,不用另外改升級公式。
//
// cooldownTicks 2026-07-20 微調過一次:算 dps(=damage/cooldownTicks)對照 rangeFp 發現
// metal 同時贏過 fire(dps 更高、射程更長)、贏過 earth(同樣兩項都贏),water 又輸給 wood
// (dps 打平但射程更短)——同樣 cost 卻有元素在數值上被另一個完全比下去,等於沒有選它的理由。
// 只調 cooldownTicks(每一擊的 damage 數字不動,維持「單發傷害」這個手感跟 burst 分歧路線的
// 意義),讓 5 個屬性照 range 由高到低排列時 dps 剛好由低到高排列(wood<water<metal<earth<
// fire),彼此之間變成純粹的「射程 vs 攻速」取捨,沒有任何一個屬性在數值上單方面完勝另一個。
export const TOWER_DEFS: Record<Element, TowerDef> = {
  metal: { element: 'metal', cost: 70, damage: 14, rangeFp: 2300, cooldownTicks: 25 },
  wood: { element: 'wood', cost: 70, damage: 6, rangeFp: 2800, cooldownTicks: 13 },
  earth: { element: 'earth', cost: 70, damage: 10, rangeFp: 2200, cooldownTicks: 17 },
  water: { element: 'water', cost: 70, damage: 8, rangeFp: 2500, cooldownTicks: 16 },
  fire: { element: 'fire', cost: 70, damage: 12, rangeFp: 2000, cooldownTicks: 18 },
};

/** 隨機英雄選擇 UI 顯示用的角色名(參考 WC3 TD 的手塔風味),不影響任何數值判定。 */
export const TOWER_CHARACTER_NAMES: Record<Element, string> = {
  metal: '黃金衛士',
  wood: '森林游俠',
  water: '碧波法師',
  fire: '烈焰武士',
  earth: '磐石守衛',
};

/** 雙屬性塔基礎傷害只有兩屬性平均值的這個百分比——換取「不會出現弱勢傷害」的一致性,代價是輸出打折。 */
export const DUAL_TOWER_DAMAGE_PERCENT = 80;
/** 雙屬性塔造價是兩屬性平均造價的這個百分比(180 = 1.8 倍)——比蓋兩座單屬性塔便宜,但比蓋一座貴不少。 */
export const DUAL_TOWER_COST_MULTIPLIER_PERCENT = 180;

/**
 * 雙屬性塔的基礎數值:cost/damage 是兩屬性平均後再套用上面兩個百分比,rangeFp/cooldownTicks
 * 單純取平均、不額外調整(射程/攻速的取捨已經留給玩家選的兩個屬性本身去體現,不用再疊一層折扣)。
 * `element` 欄位純粹沿用 e1 給型別相容,不代表這個 def 只吃 e1 的傷害判定
 * (真正的傷害/移動類型判定要看 Tower.element + Tower.secondElement 兩個,見 tryAttack/findTarget)。
 */
export function dualTowerStats(e1: Element, e2: Element): TowerDef {
  const d1 = TOWER_DEFS[e1];
  const d2 = TOWER_DEFS[e2];
  return {
    element: e1,
    cost: Math.floor(((d1.cost + d2.cost) * DUAL_TOWER_COST_MULTIPLIER_PERCENT) / 200),
    damage: Math.floor(((d1.damage + d2.damage) * DUAL_TOWER_DAMAGE_PERCENT) / 200),
    rangeFp: Math.floor((d1.rangeFp + d2.rangeFp) / 2),
    cooldownTicks: Math.floor((d1.cooldownTicks + d2.cooldownTicks) / 2),
  };
}

/** 塔目前實際吃的基礎數值——單屬性塔查表,雙屬性塔改用兩屬性平均後的折扣/溢價數值。 */
function baseTowerDef(tower: Pick<Tower, 'element' | 'secondElement'>): TowerDef {
  return tower.secondElement ? dualTowerStats(tower.element, tower.secondElement) : TOWER_DEFS[tower.element];
}

/** UI 顯示用的塔名稱,雙屬性塔顯示兩個角色名組合,不用另外設計新的角色名。 */
export function towerDisplayName(tower: Pick<Tower, 'element' | 'secondElement'>): string {
  if (!tower.secondElement) return TOWER_CHARACTER_NAMES[tower.element];
  return `${TOWER_CHARACTER_NAMES[tower.element]}×${TOWER_CHARACTER_NAMES[tower.secondElement]}`;
}

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
  /**
   * 雙屬性塔(2026-07-21 加的,元素組合玩法):蓋塔當下就定案、之後不能改(跟升級分岐不同,
   * 這個不是升級解鎖的,是建塔時的另一種選項)。不存在代表一般的單屬性塔。傷害/移動類型判定
   * 都改吃「兩個屬性各自算、取比較好的那個」(見 elements.ts 的 bestElementRelation、
   * towers.ts 的 canDualTargetMoveType),基礎數值則是兩屬性平均後套用折扣/溢價
   * (見 dualTowerStats)。
   */
  secondElement?: Element;
}

/** 升級花費:每一級都用原始建造價當漲幅單位,越高級越貴。已滿級回傳 null。 */
export function upgradeCost(tower: Tower): number | null {
  if (tower.level >= MAX_TOWER_LEVEL) return null;
  return baseTowerDef(tower).cost * tower.level;
}

/** 賣出可以拿回的金幣;跟 simulation.ts 的 applySellTower 共用同一個公式,避免兩邊算法各改各的漂掉。 */
export function sellValue(tower: Tower): number {
  return Math.floor(baseTowerDef(tower).cost / 2);
}

export interface TotemEffect {
  /** 0 = 沒有加成。多座圖騰在範圍內同時生效時取最大值,不會疊加相加(避免堆圖騰數值爆炸)。 */
  damageBonusPercent: number;
  hastePercent: number;
}

/**
 * 進階版圖騰:1 級(或還沒分歧)一律是 `damage` 效果、用基礎版的百分比;2 級才會依
 * `upgradePath` 決定實際套用哪一種、用哪個百分比——`damage` 分歧路線把百分比加重,`haste`
 * 分歧路線整個換成攻速加成(兩者互斥,同一座圖騰不會同時給兩種效果)。範圍內同時有好幾座
 * 圖騰(可能分歧路線不同)時,傷害/攻速各自取範圍內最大值,不會通通疊加相加。
 */
export function nearbyTotemEffect(tower: Tower, runeTotems: readonly RuneTotem[]): TotemEffect {
  const towerXFp = tower.x * FP_SCALE;
  const towerYFp = tower.y * FP_SCALE;
  const rangeSq = RUNE_TOTEM_RANGE_FP * RUNE_TOTEM_RANGE_FP;
  let damageBonusPercent = 0;
  let hastePercent = 0;
  for (const totem of runeTotems) {
    const dx = towerXFp - totem.x * FP_SCALE;
    const dy = towerYFp - totem.y * FP_SCALE;
    if (dx * dx + dy * dy > rangeSq) continue;
    if (totem.level >= MAX_RUNE_TOTEM_LEVEL && totem.upgradePath === 'haste') {
      hastePercent = Math.max(hastePercent, RUNE_TOTEM_HASTE_PERCENT);
    } else {
      const percent =
        totem.level >= MAX_RUNE_TOTEM_LEVEL && totem.upgradePath === 'damage'
          ? RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED
          : RUNE_TOTEM_DAMAGE_BONUS_PERCENT;
      damageBonusPercent = Math.max(damageBonusPercent, percent);
    }
  }
  return { damageBonusPercent, hastePercent };
}

/**
 * 1~2 級(或還沒選路線前)是線性倍增;到 UPGRADE_PATH_LEVEL 選了 'burst' 路線後,傷害
 * 比線性更陡(BURST_DAMAGE_PERCENT);選 'splash' 路線則維持線性不額外加成,因為傷害輸出
 * 靠 tryAttack 的範圍波及效果拿,不是靠單體數字堆疊。範圍/冷卻留給之後平衡調整。
 * 圖騰的傷害加成(見 nearbyTotemEffect())在等級/路線加成算完之後才乘,兩者疊加。
 */
function effectiveDamage(tower: Tower, runeTotems: readonly RuneTotem[]): number {
  const def = baseTowerDef(tower);
  let base = def.damage * tower.level;
  if (tower.level >= UPGRADE_PATH_LEVEL && tower.upgradePath === 'burst') {
    base = Math.floor((base * BURST_DAMAGE_PERCENT) / 100);
  }
  const { damageBonusPercent } = nearbyTotemEffect(tower, runeTotems);
  if (damageBonusPercent > 0) {
    base = Math.floor((base * (100 + damageBonusPercent)) / 100);
  }
  return base;
}

/**
 * 組合建築玩法(相生):塔相鄰(含斜角,3x3 範圍內扣掉自己)蓋了「生」它的那個元素(五行相生,見
 * elements.ts 的 GENERATED_BY),就會被滋養、攻速變快。故意用「生」而不是「克」的關係,
 * 才不會跟怪物傷害倍率(elements.ts 的 elementRelation)是同一套規則的兩種說法,讓玩家有
 * 兩種獨立的五行知識可以組合利用。範圍是即時算的(每次呼叫都重新掃鄰居),不是蓋塔當下
 * 定案,所以鄰居塔被賣掉/新蓋都會立刻反映,不用特別處理「快取失效」。
 */
export function hasGeneratingNeighbor(tower: Tower, allTowers: readonly Tower[]): boolean {
  const sourceElement = GENERATED_BY[tower.element];
  for (const other of allTowers) {
    if (other.id === tower.id || other.element !== sourceElement) continue;
    if (Math.abs(other.x - tower.x) <= 1 && Math.abs(other.y - tower.y) <= 1) return true;
  }
  return false;
}

/** 鄰接加成生效時,冷卻時間打這個百分比折扣(85 = 快 15%)。 */
const ADJACENCY_COOLDOWN_PERCENT = 85;

/**
 * 冷卻時間依序打兩層折扣(相生鄰接 + 疾風圖騰,兩個來源各自獨立,都生效時會複合疊加,
 * 不是只算比較大的那個):相生鄰接固定折扣、圖騰疾風折扣依 `nearbyTotemEffect()` 算。
 */
function effectiveCooldownTicks(tower: Tower, allTowers: readonly Tower[], runeTotems: readonly RuneTotem[]): number {
  let base = baseTowerDef(tower).cooldownTicks;
  if (hasGeneratingNeighbor(tower, allTowers)) {
    base = Math.floor((base * ADJACENCY_COOLDOWN_PERCENT) / 100);
  }
  const { hastePercent } = nearbyTotemEffect(tower, runeTotems);
  if (hastePercent > 0) {
    base = Math.floor((base * (100 - hastePercent)) / 100);
  }
  return Math.max(1, base);
}

export interface TowerStats {
  damage: number;
  rangeFp: number;
  cooldownTicks: number;
  upgradeCost: number | null;
  sellValue: number;
  upgradePath: UpgradePath;
  /** 目前是不是有相生鄰居在加速——純顯示用,面板/地圖靠這個決定要不要顯示加成標示。 */
  adjacencyBonusActive: boolean;
  /** 目前範圍內圖騰給的傷害加成百分比(0 = 沒有),純顯示用。 */
  totemDamageBonusPercent: number;
  /** 目前範圍內圖騰給的攻速加成百分比(0 = 沒有),純顯示用。 */
  totemHastePercent: number;
}

/** 給 UI 顯示用(WC3 式選取面板):這座塔目前的實際數值(已套用等級加成+鄰接加成+圖騰加成)+ 升級/賣出的花費。 */
export function describeTower(tower: Tower, allTowers: readonly Tower[], runeTotems: readonly RuneTotem[]): TowerStats {
  const def = baseTowerDef(tower);
  const totemEffect = nearbyTotemEffect(tower, runeTotems);
  return {
    damage: effectiveDamage(tower, runeTotems),
    rangeFp: def.rangeFp,
    cooldownTicks: effectiveCooldownTicks(tower, allTowers, runeTotems),
    upgradeCost: upgradeCost(tower),
    sellValue: sellValue(tower),
    upgradePath: tower.upgradePath,
    adjacencyBonusActive: hasGeneratingNeighbor(tower, allTowers),
    totemDamageBonusPercent: totemEffect.damageBonusPercent,
    totemHastePercent: totemEffect.hastePercent,
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

/** 這座塔打不打得到這種移動類型——單屬性查表,雙屬性改用 canDualTargetMoveType(OR 邏輯)。 */
function towerCanTargetMoveType(tower: Pick<Tower, 'element' | 'secondElement'>, moveType: MoveType): boolean {
  return tower.secondElement
    ? canDualTargetMoveType(tower.element, tower.secondElement, moveType)
    : canTargetMoveType(tower.element, moveType);
}

/** 這座塔打中 defender 時的傷害倍率判定——單屬性用一般的 elementRelation,雙屬性取兩屬性較好的那個。 */
function towerElementalDamage(tower: Pick<Tower, 'element' | 'secondElement'>, baseDamage: number, defender: Element): number {
  return tower.secondElement
    ? applyDualElementalDamage(baseDamage, tower.element, tower.secondElement, defender)
    : applyElementalDamage(baseDamage, tower.element, defender);
}

/** 範圍內依塔的集火策略選一個目標(預設 first=最靠近終點)。 */
function findTarget(monsters: readonly Monster[], tower: Tower, def: TowerDef): Monster | null {
  const towerXFp = tower.x * FP_SCALE;
  const towerYFp = tower.y * FP_SCALE;
  const rangeSq = def.rangeFp * def.rangeFp;
  let best: Monster | null = null;
  for (const m of monsters) {
    if (!towerCanTargetMoveType(tower, m.moveType)) continue;
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
 * 沒打中回傳空陣列。allTowers 是全場所有塔(含自己),用來算鄰接加成(見 hasGeneratingNeighbor);
 * runeTotems 是全場所有符文圖騰,用來算圖騰增傷/加速(見 nearbyTotemEffect)。
 */
export function tryAttack(
  tower: Tower,
  monsters: readonly Monster[],
  allTowers: readonly Tower[],
  runeTotems: readonly RuneTotem[],
): CombatEvent[] {
  const def = baseTowerDef(tower);
  tower.ticksSinceLastAttack += 1;
  if (tower.ticksSinceLastAttack < effectiveCooldownTicks(tower, allTowers, runeTotems)) return [];
  const target = findTarget(monsters, tower, def);
  if (!target) return [];
  tower.ticksSinceLastAttack = 0;
  const damage = towerElementalDamage(tower, effectiveDamage(tower, runeTotems), target.element);
  target.hp -= damage;
  const targetPosFp = worldPositionFp(target.pos);
  const events: CombatEvent[] = [{ monsterId: target.id, xFp: targetPosFp.xFp, yFp: targetPosFp.yFp, damage }];

  // splash 路線:主目標旁邊 SPLASH_RANGE_FP 定點數距離內的其他怪物也各自挨一下折扣傷害
  // (一樣用距離平方比較,不用 sqrt,決定性不受影響)。
  if (tower.level >= UPGRADE_PATH_LEVEL && tower.upgradePath === 'splash') {
    const splashRangeSq = SPLASH_RANGE_FP * SPLASH_RANGE_FP;
    for (const m of monsters) {
      if (m.id === target.id) continue;
      if (!towerCanTargetMoveType(tower, m.moveType)) continue;
      const { xFp, yFp } = worldPositionFp(m.pos);
      const dx = targetPosFp.xFp - xFp;
      const dy = targetPosFp.yFp - yFp;
      if (dx * dx + dy * dy > splashRangeSq) continue;
      const splashDamage = towerElementalDamage(
        tower,
        Math.floor((effectiveDamage(tower, runeTotems) * SPLASH_DAMAGE_PERCENT) / 100),
        m.element,
      );
      m.hp -= splashDamage;
      events.push({ monsterId: m.id, xFp, yFp, damage: splashDamage });
    }
  }

  return events;
}
