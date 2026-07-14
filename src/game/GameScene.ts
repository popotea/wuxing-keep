// Phase 5 骨架:先用 Phaser 的 Graphics 畫幾何圖形頂著(跟原本 canvas 測試頁視覺上一致),
// 之後要換真正的圖片/精靈只需要改這個檔案內部的畫法,對外介面(renderState/onTilePlaced)不用動。

import Phaser from 'phaser';
import type { Element } from '../sim/elements';
import { FP_SCALE, GRID_HEIGHT, GRID_WIDTH, inBounds, isOnPath, worldPositionFp } from '../sim/map';
import type { SimulationState } from '../sim/simulation';
import { MAX_TOWER_LEVEL } from '../sim/towers';

export const TILE_PX = 40;
// 塔/怪物的造型尺寸都是照 TILE_PX=32 時的手感調的,乘這個比例就能跟著 TILE_PX 一起放大,不用重調數字。
const SCALE = TILE_PX / 32;

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
  /** 選到塔(WC3 式:點塔是選取,不是直接升級)或取消選取時呼叫,null 代表沒有選取任何塔。 */
  onTowerSelected: ((towerId: number | null) => void) | null = null;

  private dynamicLayer!: Phaser.GameObjects.Graphics;
  private previewLayer!: Phaser.GameObjects.Graphics;
  private pendingState: SimulationState | null = null;
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  private selectedTowerId: number | null = null;

  constructor() {
    super('game');
  }

  create(): void {
    this.drawStaticLayer();
    this.dynamicLayer = this.add.graphics();
    this.previewLayer = this.add.graphics();

    // 魔獸爭霸式的建造預覽:滑鼠移到哪一格,先用顏色告訴玩家「這格能不能蓋/能不能升級」,
    // 不用等點下去才知道結果——這樣也不會再誤會格線跟路徑重疊在哪裡分不清楚。
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.hoverX = Math.floor(pointer.x / TILE_PX);
      this.hoverY = Math.floor(pointer.y / TILE_PX);
      this.drawPreview();
    });
    this.input.on('pointerout', () => {
      this.hoverX = null;
      this.hoverY = null;
      this.drawPreview();
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const x = Math.floor(pointer.x / TILE_PX);
      const y = Math.floor(pointer.y / TILE_PX);
      const tower = this.pendingState?.towers.find((t) => t.x === x && t.y === y);
      if (tower) {
        // 點已經選取的塔再點一次 = 取消選取;點別座塔 = 換選取,都不會直接觸發升級。
        this.setSelectedTower(this.selectedTowerId === tower.id ? null : tower.id);
        return;
      }
      this.setSelectedTower(null);
      this.onTilePlaced?.(x, y);
    });

    // renderState() 可能在 Phaser 完成 boot、create() 真正執行前就先被呼叫,
    // 這時候先記住最新一份 state,create() 一跑完馬上補畫。
    if (this.pendingState) this.drawDynamicLayer(this.pendingState);
  }

  renderState(state: SimulationState): void {
    this.pendingState = state;
    // 選取的塔可能被賣掉/不存在了(例如多人連線裡別人把它賣了),自動取消選取。
    if (this.selectedTowerId !== null && !state.towers.some((t) => t.id === this.selectedTowerId)) {
      this.setSelectedTower(null);
    }
    if (this.dynamicLayer) this.drawDynamicLayer(state);
    if (this.previewLayer) this.drawPreview();
  }

  /** main.ts 賣塔/取消選取後也會呼叫這個,讓畫面跟資訊面板保持同步。 */
  setSelectedTower(towerId: number | null): void {
    this.selectedTowerId = towerId;
    this.onTowerSelected?.(towerId);
    if (this.pendingState && this.dynamicLayer) this.drawDynamicLayer(this.pendingState);
  }

  private drawStaticLayer(): void {
    const g = this.add.graphics();

    // 草地用棋盤式雙色交錯,打破整片同色的單調感(還沒有真正的地板材質前,這是最便宜的立體感來源)
    for (let x = 0; x < GRID_WIDTH; x++) {
      for (let y = 0; y < GRID_HEIGHT; y++) {
        if (isOnPath(x, y)) continue;
        g.fillStyle((x + y) % 2 === 0 ? 0x2f4d33 : 0x355a3a, 1);
        g.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }
    }

    // 路徑整格塗滿(不是只畫一條細線穿過格子中心)——這樣「這格到底算不算路徑」
    // 一眼就看得出來,不會再跟格線混在一起分不清楚可不可以蓋。
    g.fillStyle(0x6b5541, 1);
    for (let x = 0; x < GRID_WIDTH; x++) {
      for (let y = 0; y < GRID_HEIGHT; y++) {
        if (isOnPath(x, y)) g.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }
    }

    // 路徑邊緣加一圈深色描邊(只描跟草地交界的那幾條邊),看起來像被踩出來的土路,不是一塊生硬的色塊
    g.lineStyle(2, 0x4a3c2e, 0.9);
    for (let x = 0; x < GRID_WIDTH; x++) {
      for (let y = 0; y < GRID_HEIGHT; y++) {
        if (!isOnPath(x, y)) continue;
        const px = x * TILE_PX;
        const py = y * TILE_PX;
        if (!isOnPath(x, y - 1)) g.lineBetween(px, py, px + TILE_PX, py);
        if (!isOnPath(x, y + 1)) g.lineBetween(px, py + TILE_PX, px + TILE_PX, py + TILE_PX);
        if (!isOnPath(x - 1, y)) g.lineBetween(px, py, px, py + TILE_PX);
        if (!isOnPath(x + 1, y)) g.lineBetween(px + TILE_PX, py, px + TILE_PX, py + TILE_PX);
      }
    }

    // 格線只是輔助對齊,故意畫得很淡,不要跟地面/路徑的色塊搶視覺(魔獸爭霸地圖本身也不會畫出格線)
    g.lineStyle(1, 0x000000, 0.12);
    for (let x = 0; x <= GRID_WIDTH; x++) {
      g.lineBetween(x * TILE_PX, 0, x * TILE_PX, GRID_HEIGHT * TILE_PX);
    }
    for (let y = 0; y <= GRID_HEIGHT; y++) {
      g.lineBetween(0, y * TILE_PX, GRID_WIDTH * TILE_PX, y * TILE_PX);
    }
  }

  /** 綠=可以蓋塔、金=已有塔(點下去是選取,不是直接升級)、紅=路徑格不能蓋,滑鼠移過去就先知道結果。 */
  private drawPreview(): void {
    const g = this.previewLayer;
    g.clear();
    if (this.hoverX === null || this.hoverY === null) return;
    const x = this.hoverX;
    const y = this.hoverY;
    if (!inBounds(x, y)) return;

    const hasTower = this.pendingState?.towers.some((t) => t.x === x && t.y === y) ?? false;
    const blocked = isOnPath(x, y);
    const color = blocked ? 0xe0433a : hasTower ? 0xd4af37 : 0x3ad95a;

    g.fillStyle(color, 0.35);
    g.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
    g.lineStyle(2, color, 0.9);
    g.strokeRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
  }

  private drawDynamicLayer(state: SimulationState): void {
    const g = this.dynamicLayer;
    g.clear();

    for (const t of state.towers) this.drawTower(g, t.x, t.y, t.element, t.level);

    if (this.selectedTowerId !== null) {
      const selected = state.towers.find((t) => t.id === this.selectedTowerId);
      if (selected) {
        g.lineStyle(3, 0xffffff, 0.9);
        g.strokeRect(selected.x * TILE_PX + 2, selected.y * TILE_PX + 2, TILE_PX - 4, TILE_PX - 4);
      }
    }

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

    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(cx, cy + 9 * SCALE, 22 * SCALE, 6 * SCALE);

    g.fillStyle(0x222222, 1);
    g.fillRect(cx - 10 * SCALE, cy + 2 * SCALE, 20 * SCALE, 6 * SCALE);

    g.fillStyle(ELEMENT_COLORS[element], 1);
    g.fillTriangle(cx, cy - 12 * SCALE, cx - 10 * SCALE, cy + 6 * SCALE, cx + 10 * SCALE, cy + 6 * SCALE);

    const pipSpacing = 5 * SCALE;
    const pipsWidth = (Math.min(level, MAX_TOWER_LEVEL) - 1) * pipSpacing;
    for (let i = 0; i < level; i++) {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(cx - pipsWidth / 2 + i * pipSpacing, cy - 17 * SCALE, 1.5 * SCALE);
    }
  }

  /** 圓身 + 小眼睛 + 頭上血條,取代原本的純色方塊。 */
  private drawMonster(g: Phaser.GameObjects.Graphics, px: number, py: number, element: Element, hpRatio: number): void {
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(px, py + 5 * SCALE, 12 * SCALE, 4 * SCALE);

    g.fillStyle(ELEMENT_COLORS[element], 1);
    g.fillCircle(px, py, 6 * SCALE);
    g.fillStyle(0x1a1a1a, 1);
    g.fillCircle(px + 2 * SCALE, py - 2 * SCALE, 1.5 * SCALE);

    const ratio = Math.max(0, Math.min(1, hpRatio));
    const barColor = ratio > 0.5 ? 0x3a9d3a : ratio > 0.25 ? 0xd4af37 : 0xe05a2b;
    const barW = 16 * SCALE;
    const barH = 3 * SCALE;
    g.fillStyle(0x000000, 0.6);
    g.fillRect(px - barW / 2, py - 12 * SCALE, barW, barH);
    g.fillStyle(barColor, 1);
    g.fillRect(px - barW / 2, py - 12 * SCALE, barW * ratio, barH);
  }
}
