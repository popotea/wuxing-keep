// 把 Phaser.Game 的建立/銷毀包起來,main.ts 只需要呼叫 renderState()/destroy(),
// 不用直接碰 Phaser API——之後真的要換場景結構或加圖層,外部呼叫方式不用改。

import Phaser from 'phaser';
import { VIEWPORT_TILES_H, VIEWPORT_TILES_W } from '../sim/map';
import type { SimulationState } from '../sim/simulation';
import { GameScene, TILE_PX } from './GameScene';

export interface GameRenderer {
  renderState(state: SimulationState): void;
  setSelectedTower(towerId: number | null): void;
  /** 新對局開始時呼叫:Phaser.Game 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零。 */
  resetCamera(): void;
  destroy(): void;
}

export function createGameRenderer(
  parentId: string,
  onTilePlaced: (x: number, y: number) => void,
  onTowerSelected: (towerId: number | null) => void,
): GameRenderer {
  const scene = new GameScene();
  scene.onTilePlaced = onTilePlaced;
  scene.onTowerSelected = onTowerSelected;

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: parentId,
    // 畫布維持原本的可視大小(視窗),地圖(世界)本身比這個大很多,超出的部分靠 GameScene 的邊緣平移看到。
    width: VIEWPORT_TILES_W * TILE_PX,
    height: VIEWPORT_TILES_H * TILE_PX,
    backgroundColor: '#1e1e1e',
    scene,
  });

  return {
    renderState: (state) => scene.renderState(state),
    setSelectedTower: (towerId) => scene.setSelectedTower(towerId),
    resetCamera: () => scene.resetCamera(),
    destroy: () => game.destroy(true),
  };
}
