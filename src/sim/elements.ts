// 五行相剋:金克木 → 木克土 → 土克水 → 水克火 → 火克金 → (回到金)。
// 用正統五行相剋循環,不是自創的克制關係——傷害倍率一律用整數乘除,避免浮點誤差跨機不一致。

export type Element = 'metal' | 'wood' | 'water' | 'fire' | 'earth';

export const ELEMENT_NAMES: Record<Element, string> = {
  metal: '金',
  wood: '木',
  water: '水',
  fire: '火',
  earth: '土',
};

export const ALL_ELEMENTS: readonly Element[] = ['metal', 'wood', 'water', 'fire', 'earth'];

const BEATS: Record<Element, Element> = {
  metal: 'wood',
  wood: 'earth',
  earth: 'water',
  water: 'fire',
  fire: 'metal',
};

// 五行相生(木生火→火生土→土生金→金生水→水生木→回到木),故意跟上面的「相克」是不同循環順序
// (正統五行本來就有相生/相克兩套獨立關係)——塔的鄰接加成(towers.ts 的 hasGeneratingNeighbor())
// 用這套「生」的關係,才不會跟怪物傷害倍率用的「克」關係混在一起變成同一套規則的兩種說法。
export const GENERATED_BY: Record<Element, Element> = {
  fire: 'wood',
  earth: 'fire',
  metal: 'earth',
  water: 'metal',
  wood: 'water',
};

export type ElementRelation = 'strong' | 'weak' | 'neutral';

export function elementRelation(attacker: Element, defender: Element): ElementRelation {
  if (BEATS[attacker] === defender) return 'strong';
  if (BEATS[defender] === attacker) return 'weak';
  return 'neutral';
}

/** 整數除法(乘 3 除 2 / 除 4 再 floor),同樣的輸入在任何機器上都算出同一個整數結果。 */
function damageForRelation(baseDamage: number, relation: ElementRelation): number {
  if (relation === 'strong') return Math.floor((baseDamage * 3) / 2);
  if (relation === 'weak') return Math.floor((baseDamage * 3) / 4);
  return baseDamage;
}

export function applyElementalDamage(baseDamage: number, attacker: Element, defender: Element): number {
  return damageForRelation(baseDamage, elementRelation(attacker, defender));
}

const RELATION_RANK: Record<ElementRelation, number> = { strong: 2, neutral: 1, weak: 0 };

/**
 * 雙屬性塔的判定(towers.ts 的 Tower.secondElement):兩個屬性各自對目標算一次 relation,
 * 取「比較好」的那個。因為 BEATS 是每個屬性只被唯一一個屬性克制的單一循環,目標最多只能
 * 克制 e1/e2 其中一個(不可能同時克制兩個不同的屬性),所以雙屬性塔對任何目標最差就是
 * neutral,不會出現「弱」的倍率——用來換取「沒有致命對位」的一致性,代價由 towers.ts
 * 的基礎數值折扣去平衡(見 DUAL_TOWER_DAMAGE_PERCENT),不是這裡的判定邏輯要處理的事。
 */
export function bestElementRelation(e1: Element, e2: Element, defender: Element): ElementRelation {
  const relA = elementRelation(e1, defender);
  const relB = elementRelation(e2, defender);
  return RELATION_RANK[relA] >= RELATION_RANK[relB] ? relA : relB;
}

export function applyDualElementalDamage(baseDamage: number, e1: Element, e2: Element, defender: Element): number {
  return damageForRelation(baseDamage, bestElementRelation(e1, e2, defender));
}

export function isElement(v: unknown): v is Element {
  return v === 'metal' || v === 'wood' || v === 'water' || v === 'fire' || v === 'earth';
}
