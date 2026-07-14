// 把 Phaser.Game 的建立/銷毀包起來,main.ts 只需要呼叫 renderState()/destroy(),
// 不用直接碰 Phaser API——之後真的要換場景結構或加圖層,外部呼叫方式不用改。

import Phaser from 'phaser';
import { GRID_HEIGHT, GRID_WIDTH } from '../sim/map';
import type { SimulationState } from '../sim/simulation';
import { GameScene, TILE_PX } from './GameScene';

export interface GameRenderer {
  renderState(state: SimulationState): void;
  destroy(): void;
}

export function createGameRenderer(
  parentId: string,
  onTilePlaced: (x: number, y: number) => void,
): GameRenderer {
  const scene = new GameScene();
  scene.onTilePlaced = onTilePlaced;

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: parentId,
    width: GRID_WIDTH * TILE_PX,
    height: GRID_HEIGHT * TILE_PX,
    backgroundColor: '#1e1e1e',
    scene,
  });

  return {
    renderState: (state) => scene.renderState(state),
    destroy: () => game.destroy(true),
  };
}
