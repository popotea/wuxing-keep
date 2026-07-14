// 怪物與波次。波次全部是寫死的腳本(數量/血量/速度/賞金都是常數),
// 完全不需要亂數——省掉「RNG 演算法在不同瀏覽器要跑出一樣結果」這個額外風險。

import type { Element } from './elements';
import { createStartPos, type PathPos } from './map';

export interface Monster {
  id: number;
  element: Element;
  hp: number;
  maxHp: number;
  speedFp: number;
  bounty: number;
  pos: PathPos;
}

export interface WaveDef {
  element: Element;
  count: number;
  hp: number;
  speedFp: number;
  bounty: number;
}

export const WAVE_INTERVAL_TICKS = 400; // 20 tick/秒 * 20 秒
export const SPAWN_INTERVAL_TICKS = 20; // 同波怪物間隔 1 秒

// 數值都是先求「能玩」的佔位平衡,真正調數值是 Phase 5 的事。
export const WAVES: readonly WaveDef[] = [
  { element: 'water', count: 6, hp: 40, speedFp: 60, bounty: 10 },
  { element: 'fire', count: 6, hp: 55, speedFp: 65, bounty: 12 },
  { element: 'wood', count: 8, hp: 70, speedFp: 60, bounty: 14 },
  { element: 'earth', count: 8, hp: 90, speedFp: 55, bounty: 16 },
  { element: 'metal', count: 10, hp: 110, speedFp: 60, bounty: 18 },
  { element: 'fire', count: 12, hp: 130, speedFp: 70, bounty: 22 },
];

export function totalWaveTicks(): number {
  return WAVES.length * WAVE_INTERVAL_TICKS;
}

export interface SpawnEvent {
  element: Element;
  hp: number;
  speedFp: number;
  bounty: number;
}

/** 純函式:給定 tick,回傳這一 tick 該生出的怪物。同一個 tick 在哪台機器算都是同一個答案。 */
export function getSpawnEventsForTick(tick: number): SpawnEvent[] {
  const events: SpawnEvent[] = [];
  for (let i = 0; i < WAVES.length; i++) {
    const wave = WAVES[i];
    const waveStartTick = i * WAVE_INTERVAL_TICKS;
    for (let j = 0; j < wave.count; j++) {
      const spawnTick = waveStartTick + j * SPAWN_INTERVAL_TICKS;
      if (spawnTick === tick) {
        events.push({ element: wave.element, hp: wave.hp, speedFp: wave.speedFp, bounty: wave.bounty });
      }
    }
  }
  return events;
}

export function createMonster(id: number, spawn: SpawnEvent): Monster {
  return {
    id,
    element: spawn.element,
    hp: spawn.hp,
    maxHp: spawn.hp,
    speedFp: spawn.speedFp,
    bounty: spawn.bounty,
    pos: createStartPos(),
  };
}
