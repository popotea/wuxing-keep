// 多人時分辨「這座塔/陷阱/資源建築是誰蓋的」用的識別色——純顯示用,不影響任何模擬邏輯。
// 玩家順序取 state.gold 的 key 排序後的位置:對局開始 SimulationState.gold 的玩家集合就固定
// (不支援中途加入),排序後的 index 在所有機器上都會算出同一個結果,不受 Record 鍵插入順序影響。

import type { SimulationState } from '../sim/simulation';

const PALETTE: readonly number[] = [
  0xff5c5c, // 紅
  0x4fa8ff, // 藍
  0xffd23f, // 黃
  0x4fd88a, // 綠
  0xd66bff, // 紫
  0x36e0d0, // 青
  0xff9d4d, // 橘
  0xb0b0b0, // 灰
];

function ownerIndex(state: SimulationState, ownerId: string): number {
  const ids = Object.keys(state.gold).sort();
  const idx = ids.indexOf(ownerId);
  return idx < 0 ? 0 : idx % PALETTE.length;
}

/** 只有 2 人以上才需要區分「誰蓋的」,單人模式沒有意義,呼叫端應該只在多人時使用。 */
export function isMultiplayer(state: SimulationState): boolean {
  return Object.keys(state.gold).length > 1;
}

export function ownerColorHex(state: SimulationState, ownerId: string): number {
  return PALETTE[ownerIndex(state, ownerId)];
}

export function ownerColorCss(state: SimulationState, ownerId: string): string {
  return `#${PALETTE[ownerIndex(state, ownerId)].toString(16).padStart(6, '0')}`;
}
