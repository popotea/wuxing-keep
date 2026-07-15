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
export function applyElementalDamage(baseDamage: number, attacker: Element, defender: Element): number {
  const relation = elementRelation(attacker, defender);
  if (relation === 'strong') return Math.floor((baseDamage * 3) / 2);
  if (relation === 'weak') return Math.floor((baseDamage * 3) / 4);
  return baseDamage;
}

export function isElement(v: unknown): v is Element {
  return v === 'metal' || v === 'wood' || v === 'water' || v === 'fire' || v === 'earth';
}
