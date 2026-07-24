// 把 Phaser.Game 的建立/銷毀包起來,main.ts 只需要呼叫 renderState()/destroy(),
// 不用直接碰 Phaser API——之後真的要換場景結構或加圖層,外部呼叫方式不用改。

import Phaser from 'phaser';
import { VIEWPORT_TILES_H, VIEWPORT_TILES_W } from '../sim/map';
import type { SimulationState } from '../sim/simulation';
import { GameScene, TILE_PX, type HoverInfo } from './GameScene';

export type { HoverInfo };

export interface GameRenderer {
  renderState(state: SimulationState): void;
  setSelectedTower(towerId: number | null): void;
  /** 格子座標 → 畫布像素座標(鏡頭縮放/平移都算進去),塔的浮動操作選單定位用。 */
  tileToCanvas(tileX: number, tileY: number): { x: number; y: number };
  /**
   * 告訴渲染層「本機玩家是誰」——個人生命模式要在地圖上標出「你負責的路徑」
   * (識別色鋪色 + 起點標籤 + 浮動箭頭),這是每台機器各自不同的顯示,不是模擬狀態。
   * 對局開始時呼叫(單人是 LOCAL_PLAYER_ID,連線是 room 給的 playerId)。
   */
  setLocalPlayerId(playerId: string | null): void;
  /** 畫面縮放按鈕用:以畫布中心為錨點縮放(factor >1 放大、<1 縮小,內部夾在 1~上限)。 */
  zoomBy(factor: number): void;
  /** 畫面縮放按鈕用:回到看全圖的預設狀態。 */
  resetZoom(): void;
  /** 建造中的暫置虛影格子(送出指令到模擬反映之間),main.ts 每 tick 更新。 */
  setPendingBuilds(list: ReadonlyArray<{ x: number; y: number }>): void;
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
  onTilePlaced: (x: number, y: number, screenX: number, screenY: number) => void,
  onTowerSelected: (towerId: number | null) => void,
  onHoverInfoChanged: (info: HoverInfo | null, screenX: number, screenY: number) => void,
): GameRenderer {
  const scene = new GameScene();
  scene.onTilePlaced = onTilePlaced;
  scene.onTowerSelected = onTowerSelected;
  scene.onHoverInfoChanged = onHoverInfoChanged;

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
    tileToCanvas: (tileX, tileY) => scene.tileToCanvas(tileX, tileY),
    setLocalPlayerId: (playerId) => {
      scene.localPlayerId = playerId;
    },
    zoomBy: (factor) => scene.zoomByFactor(factor),
    resetZoom: () => scene.resetZoom(),
    setPendingBuilds: (list) => {
      scene.pendingBuilds = list;
    },
    resetCamera: () => scene.resetCamera(),
    refreshSize: () => game.scale.refresh(),
    destroy: () => game.destroy(true),
  };
}
