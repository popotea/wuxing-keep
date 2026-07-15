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
  /**
   * #gameCanvas 從 display:none 變成可見時呼叫:Scale.RESIZE 模式平常靠瀏覽器 resize
   * 事件量測容器尺寸,但 display:none↔可見這種切換不會觸發 resize 事件,不主動叫它
   * 重新量測的話畫布會卡在建立當下(容器還是 0x0)量到的尺寸。
   */
  refreshSize(): void;
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
    // RESIZE 模式:畫布跟著 parent(#gameCanvas,CSS 撐滿版面)的實際尺寸動態調整,
    // 不是寫死的固定視窗——地圖(世界)本身還是比畫布大,超出的部分一樣靠邊緣平移看到,
    // 畫布變大只是一次能看到更多地圖、操作區域更寬敞。
    scale: {
      mode: Phaser.Scale.RESIZE,
      parent: parentId,
      width: VIEWPORT_TILES_W * TILE_PX,
      height: VIEWPORT_TILES_H * TILE_PX,
    },
    backgroundColor: '#1e1e1e',
    scene,
  });

  return {
    renderState: (state) => scene.renderState(state),
    setSelectedTower: (towerId) => scene.setSelectedTower(towerId),
    resetCamera: () => scene.resetCamera(),
    refreshSize: () => game.scale.refresh(),
    destroy: () => game.destroy(true),
  };
}
