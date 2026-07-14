// Phase 5 骨架:先用 Phaser 的 Graphics 畫幾何圖形頂著(跟原本 canvas 測試頁視覺上一致),
// 之後要換真正的圖片/精靈只需要改這個檔案內部的畫法,對外介面(renderState/onTilePlaced)不用動。

import Phaser from 'phaser';
import type { Element } from '../sim/elements';
import { FP_SCALE, GRID_HEIGHT, GRID_WIDTH, PATHS, worldPositionFp } from '../sim/map';
import type { SimulationState } from '../sim/simulation';
import { MAX_TOWER_LEVEL } from '../sim/towers';

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

    // 畫出所有路徑;交叉的地方線段會自然疊在一起,看起來就是個十字路口。
    g.lineStyle(TILE_PX * 0.6, 0x555555, 1);
    for (const waypoints of PATHS) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const [ax, ay] = waypoints[i];
        const [bx, by] = waypoints[i + 1];
        g.lineBetween(
          ax * TILE_PX + TILE_PX / 2,
          ay * TILE_PX + TILE_PX / 2,
          bx * TILE_PX + TILE_PX / 2,
          by * TILE_PX + TILE_PX / 2,
        );
      }
    }
  }

  private drawDynamicLayer(state: SimulationState): void {
    const g = this.dynamicLayer;
    g.clear();

    for (const t of state.towers) this.drawTower(g, t.x, t.y, t.element, t.level);

    for (const m of state.monsters) {
      const { xFp, yFp } = worldPositionFp(m.pos);
      const px = (xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      const py = (yFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      this.drawMonster(g, px, py, m.element, m.hp / m.maxHp);
    }
  }

  /** 底座 + 尖塔的簡易造型,比純色圓形更有辨識度;等級用塔尖上方的一排小點表示。 */
  private drawTower(g: Phaser.GameObjects.Graphics, gridX: number, gridY: number, element: Element, level: number): void {
    const cx = gridX * TILE_PX + TILE_PX / 2;
    const cy = gridY * TILE_PX + TILE_PX / 2;

    g.fillStyle(0x222222, 1);
    g.fillRect(cx - 10, cy + 2, 20, 6);

    g.fillStyle(ELEMENT_COLORS[element], 1);
    g.fillTriangle(cx, cy - 12, cx - 10, cy + 6, cx + 10, cy + 6);

    const pipSpacing = 5;
    const pipsWidth = (Math.min(level, MAX_TOWER_LEVEL) - 1) * pipSpacing;
    for (let i = 0; i < level; i++) {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(cx - pipsWidth / 2 + i * pipSpacing, cy - 17, 1.5);
    }
  }

  /** 圓身 + 小眼睛 + 頭上血條,取代原本的純色方塊。 */
  private drawMonster(g: Phaser.GameObjects.Graphics, px: number, py: number, element: Element, hpRatio: number): void {
    g.fillStyle(ELEMENT_COLORS[element], 1);
    g.fillCircle(px, py, 6);
    g.fillStyle(0x1a1a1a, 1);
    g.fillCircle(px + 2, py - 2, 1.5);

    const ratio = Math.max(0, Math.min(1, hpRatio));
    const barColor = ratio > 0.5 ? 0x3a9d3a : ratio > 0.25 ? 0xd4af37 : 0xe05a2b;
    g.fillStyle(0x000000, 0.6);
    g.fillRect(px - 8, py - 12, 16, 3);
    g.fillStyle(barColor, 1);
    g.fillRect(px - 8, py - 12, 16 * ratio, 3);
  }
}
