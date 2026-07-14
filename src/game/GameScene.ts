// Phase 5 骨架:先用 Phaser 的 Graphics 畫幾何圖形頂著(跟原本 canvas 測試頁視覺上一致),
// 之後要換真正的圖片/精靈只需要改這個檔案內部的畫法,對外介面(renderState/onTilePlaced)不用動。

import Phaser from 'phaser';
import type { Element } from '../sim/elements';
import { FP_SCALE, GRID_HEIGHT, GRID_WIDTH, PATH_WAYPOINTS, worldPositionFp } from '../sim/map';
import type { SimulationState } from '../sim/simulation';

export const TILE_PX = 32;

const ELEMENT_COLORS: Record<Element, number> = {
  metal: 0xd4af37,
  wood: 0x3a9d3a,
  water: 0x3a7bd5,
  fire: 0xe05a2b,
  earth: 0xa67c3d,
};

export class GameScene extends Phaser.Scene {
  /** main.ts 在 new GameScene() 之後、Phaser boot 完成 create() 之前就會設定好這個 callback。 */
  onTilePlaced: ((x: number, y: number) => void) | null = null;

  private dynamicLayer!: Phaser.GameObjects.Graphics;
  private pendingState: SimulationState | null = null;

  constructor() {
    super('game');
  }

  create(): void {
    this.drawStaticLayer();
    this.dynamicLayer = this.add.graphics();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const x = Math.floor(pointer.x / TILE_PX);
      const y = Math.floor(pointer.y / TILE_PX);
      this.onTilePlaced?.(x, y);
    });

    // renderState() 可能在 Phaser 完成 boot、create() 真正執行前就先被呼叫,
    // 這時候先記住最新一份 state,create() 一跑完馬上補畫。
    if (this.pendingState) this.drawDynamicLayer(this.pendingState);
  }

  renderState(state: SimulationState): void {
    this.pendingState = state;
    if (this.dynamicLayer) this.drawDynamicLayer(state);
  }

  private drawStaticLayer(): void {
    const g = this.add.graphics();

    g.lineStyle(1, 0x333333, 1);
    for (let x = 0; x <= GRID_WIDTH; x++) {
      g.lineBetween(x * TILE_PX, 0, x * TILE_PX, GRID_HEIGHT * TILE_PX);
    }
    for (let y = 0; y <= GRID_HEIGHT; y++) {
      g.lineBetween(0, y * TILE_PX, GRID_WIDTH * TILE_PX, y * TILE_PX);
    }

    g.lineStyle(TILE_PX * 0.6, 0x555555, 1);
    for (let i = 0; i < PATH_WAYPOINTS.length - 1; i++) {
      const [ax, ay] = PATH_WAYPOINTS[i];
      const [bx, by] = PATH_WAYPOINTS[i + 1];
      g.lineBetween(
        ax * TILE_PX + TILE_PX / 2,
        ay * TILE_PX + TILE_PX / 2,
        bx * TILE_PX + TILE_PX / 2,
        by * TILE_PX + TILE_PX / 2,
      );
    }
  }

  private drawDynamicLayer(state: SimulationState): void {
    const g = this.dynamicLayer;
    g.clear();

    for (const t of state.towers) {
      g.fillStyle(ELEMENT_COLORS[t.element], 1);
      g.fillCircle(t.x * TILE_PX + TILE_PX / 2, t.y * TILE_PX + TILE_PX / 2, TILE_PX * 0.35);
    }

    for (const m of state.monsters) {
      const { xFp, yFp } = worldPositionFp(m.pos);
      const px = (xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      const py = (yFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      g.fillStyle(ELEMENT_COLORS[m.element], 1);
      g.fillRect(px - 4, py - 4, 8, 8);
    }
  }
}
