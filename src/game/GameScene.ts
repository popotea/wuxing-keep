// Phase 5 骨架:先用 Phaser 的 Graphics 畫幾何圖形頂著(跟原本 canvas 測試頁視覺上一致),
// 之後要換真正的圖片/精靈只需要改這個檔案內部的畫法,對外介面(renderState/onTilePlaced)不用動。

import Phaser from 'phaser';
import type { Element } from '../sim/elements';
import { FP_SCALE, GRID_HEIGHT, GRID_WIDTH, inBounds, isOnPath, PATHS, worldPositionFp } from '../sim/map';
import type { SimulationState } from '../sim/simulation';
import { MAX_TOWER_LEVEL, TOWER_DEFS, type CombatEvent } from '../sim/towers';

export const TILE_PX = 40;
// 塔/怪物的造型尺寸都是照 TILE_PX=32 時的手感調的,乘這個比例就能跟著 TILE_PX 一起放大,不用重調數字。
const SCALE = TILE_PX / 32;

// 世紀帝國式邊緣平移:滑鼠移到畫面邊緣這麼多 px 以內,鏡頭就朝該方向捲動。
const EDGE_PAN_MARGIN_PX = 32;
const EDGE_PAN_SPEED_PX_PER_SEC = 480;

// 小地圖:固定貼在畫面右下角、跟鏡頭捲動無關(scrollFactor=0),縮小倍率讓整張地圖一次看完。
const MINIMAP_SCALE = 0.1;
const MINIMAP_MARGIN_PX = 8;

const ELEMENT_COLORS: Record<Element, number> = {
  metal: 0xd4af37,
  wood: 0x3a9d3a,
  water: 0x3a7bd5,
  fire: 0xe05a2b,
  earth: 0xa67c3d,
};

// 地圖放大後空地變多,灑一點裝飾物(樹/草叢/石頭/花/小動物)打破大片同色草地的單調感——
// 純視覺、不影響能不能蓋塔,蓋在裝飾物上的塔一樣會正常疊在上面。
const DECOR_DENSITY_PERCENT = 6;

/** 純視覺用的簡單雜湊(不是密碼學等級),只用來決定哪幾格灑裝飾物、灑哪一種,裝飾物不是模擬狀態不用管跨機器一不一致。 */
function tileHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export class GameScene extends Phaser.Scene {
  /** main.ts 在 new GameScene() 之後、Phaser boot 完成 create() 之前就會設定好這個 callback。 */
  onTilePlaced: ((x: number, y: number) => void) | null = null;
  /** 選到塔(WC3 式:點塔是選取,不是直接升級)或取消選取時呼叫,null 代表沒有選取任何塔。 */
  onTowerSelected: ((towerId: number | null) => void) | null = null;

  private dynamicLayer!: Phaser.GameObjects.Graphics;
  private previewLayer!: Phaser.GameObjects.Graphics;
  private minimapLayer!: Phaser.GameObjects.Graphics;
  private pendingState: SimulationState | null = null;
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  private selectedTowerId: number | null = null;
  /** 滑鼠是否在遊戲畫布範圍內——游標跑到畫布外的 HTML UI(HUD/塔面板)時要停止邊緣平移跟預覽。 */
  private pointerInsideCanvas = false;

  constructor() {
    super('game');
  }

  create(): void {
    this.drawStaticLayer();
    this.drawDecorations();
    this.dynamicLayer = this.add.graphics();
    this.previewLayer = this.add.graphics();
    this.minimapLayer = this.add.graphics().setScrollFactor(0); // 固定貼在螢幕上,不隨鏡頭捲動
    // 世界(地圖)比畫布視窗大很多,鏡頭預設從左上角開始,靠邊緣平移才看得到其他區域。
    this.cameras.main.setBounds(0, 0, GRID_WIDTH * TILE_PX, GRID_HEIGHT * TILE_PX);

    this.input.on('gameover', () => {
      this.pointerInsideCanvas = true;
    });
    this.input.on('gameout', () => {
      this.pointerInsideCanvas = false;
      this.hoverX = null;
      this.hoverY = null;
      this.drawPreview();
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.jumpCameraFromMinimapClick(pointer)) return;

      const { x, y } = this.tileUnderPointer(pointer);
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

  /** 小地圖左上角在螢幕座標系(scrollFactor=0)裡的位置,固定貼在畫布右下角。 */
  private minimapOrigin(): { x: number; y: number } {
    const w = GRID_WIDTH * TILE_PX * MINIMAP_SCALE;
    const h = GRID_HEIGHT * TILE_PX * MINIMAP_SCALE;
    return { x: this.scale.width - w - MINIMAP_MARGIN_PX, y: this.scale.height - h - MINIMAP_MARGIN_PX };
  }

  /** 點在小地圖範圍內就把主鏡頭跳過去(以點擊處為中心),回傳 true 代表這次點擊已經處理掉、不用再當成蓋塔/選塔。 */
  private jumpCameraFromMinimapClick(pointer: Phaser.Input.Pointer): boolean {
    const { x: ox, y: oy } = this.minimapOrigin();
    const w = GRID_WIDTH * TILE_PX * MINIMAP_SCALE;
    const h = GRID_HEIGHT * TILE_PX * MINIMAP_SCALE;
    if (pointer.x < ox || pointer.x > ox + w || pointer.y < oy || pointer.y > oy + h) return false;

    const worldX = (pointer.x - ox) / MINIMAP_SCALE;
    const worldY = (pointer.y - oy) / MINIMAP_SCALE;
    const cam = this.cameras.main;
    const maxScrollX = Math.max(0, GRID_WIDTH * TILE_PX - cam.width);
    const maxScrollY = Math.max(0, GRID_HEIGHT * TILE_PX - cam.height);
    cam.scrollX = Phaser.Math.Clamp(worldX - cam.width / 2, 0, maxScrollX);
    cam.scrollY = Phaser.Math.Clamp(worldY - cam.height / 2, 0, maxScrollY);
    return true;
  }

  /** 小地圖:縮小版全圖(路徑/塔/怪物小點)+ 一個白框標示目前鏡頭看到哪裡,點小地圖可以直接跳鏡頭過去。 */
  private drawMinimap(): void {
    const g = this.minimapLayer;
    g.clear();
    const { x: ox, y: oy } = this.minimapOrigin();
    const w = GRID_WIDTH * TILE_PX * MINIMAP_SCALE;
    const h = GRID_HEIGHT * TILE_PX * MINIMAP_SCALE;

    g.fillStyle(0x0b0d10, 0.75);
    g.fillRect(ox, oy, w, h);

    g.fillStyle(0x6b5541, 0.9);
    for (const waypoints of PATHS) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const [ax, ay] = waypoints[i];
        const [bx, by] = waypoints[i + 1];
        g.fillRect(
          ox + Math.min(ax, bx) * TILE_PX * MINIMAP_SCALE,
          oy + Math.min(ay, by) * TILE_PX * MINIMAP_SCALE,
          (Math.abs(bx - ax) + 1) * TILE_PX * MINIMAP_SCALE,
          (Math.abs(by - ay) + 1) * TILE_PX * MINIMAP_SCALE,
        );
      }
    }

    if (this.pendingState) {
      for (const t of this.pendingState.towers) {
        g.fillStyle(ELEMENT_COLORS[t.element], 1);
        g.fillCircle(ox + (t.x + 0.5) * TILE_PX * MINIMAP_SCALE, oy + (t.y + 0.5) * TILE_PX * MINIMAP_SCALE, 2);
      }
      for (const m of this.pendingState.monsters) {
        const { xFp, yFp } = worldPositionFp(m.pos);
        g.fillStyle(0xe0433a, 1);
        g.fillCircle(ox + (xFp / FP_SCALE) * TILE_PX * MINIMAP_SCALE, oy + (yFp / FP_SCALE) * TILE_PX * MINIMAP_SCALE, 1.5);
      }
    }

    g.lineStyle(1, 0xd4af37, 0.7);
    g.strokeRect(ox, oy, w, h);

    const cam = this.cameras.main;
    g.lineStyle(1.5, 0xffffff, 0.9);
    g.strokeRect(ox + cam.scrollX * MINIMAP_SCALE, oy + cam.scrollY * MINIMAP_SCALE, cam.width * MINIMAP_SCALE, cam.height * MINIMAP_SCALE);
  }

  /**
   * 螢幕座標轉成格子座標,一律透過鏡頭現在的捲動位置換算(不是直接用 pointer.worldX/Y)——
   * 邊緣平移時鏡頭每影格都在動,但滑鼠沒動的話 Phaser 不一定會重算 worldX/Y,自己算才保證準。
   */
  private tileUnderPointer(pointer: Phaser.Input.Pointer): { x: number; y: number } {
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return { x: Math.floor(world.x / TILE_PX), y: Math.floor(world.y / TILE_PX) };
  }

  /** 每影格都跑:小地圖即時更新、滑鼠停在畫布邊緣時捲動鏡頭(世紀帝國式),建造預覽格跟著鏡頭移動同步更新。 */
  update(_time: number, delta: number): void {
    this.drawMinimap();

    if (!this.pointerInsideCanvas) return;

    const pointer = this.input.activePointer;
    const tile = this.tileUnderPointer(pointer);
    this.hoverX = tile.x;
    this.hoverY = tile.y;
    this.drawPreview();

    const cam = this.cameras.main;
    let dx = 0;
    if (pointer.x <= EDGE_PAN_MARGIN_PX) dx = -1;
    else if (pointer.x >= this.scale.width - EDGE_PAN_MARGIN_PX) dx = 1;
    let dy = 0;
    if (pointer.y <= EDGE_PAN_MARGIN_PX) dy = -1;
    else if (pointer.y >= this.scale.height - EDGE_PAN_MARGIN_PX) dy = 1;
    if (dx === 0 && dy === 0) return;

    const dtSec = delta / 1000;
    const maxScrollX = Math.max(0, GRID_WIDTH * TILE_PX - cam.width);
    const maxScrollY = Math.max(0, GRID_HEIGHT * TILE_PX - cam.height);
    cam.scrollX = Phaser.Math.Clamp(cam.scrollX + dx * EDGE_PAN_SPEED_PX_PER_SEC * dtSec, 0, maxScrollX);
    cam.scrollY = Phaser.Math.Clamp(cam.scrollY + dy * EDGE_PAN_SPEED_PX_PER_SEC * dtSec, 0, maxScrollY);
  }

  renderState(state: SimulationState): void {
    this.pendingState = state;
    // 選取的塔可能被賣掉/不存在了(例如多人連線裡別人把它賣了),自動取消選取。
    if (this.selectedTowerId !== null && !state.towers.some((t) => t.id === this.selectedTowerId)) {
      this.setSelectedTower(null);
    }
    if (this.dynamicLayer) {
      this.drawDynamicLayer(state);
      for (const event of state.combatEvents) this.spawnDamageNumber(event);
    }
    if (this.previewLayer) this.drawPreview();
  }

  /** 打中怪物時飄出一個往上淡出的傷害數字,不用等真的做出命中特效素材前先有基本回饋感。 */
  private spawnDamageNumber(event: CombatEvent): void {
    const px = (event.xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
    const py = (event.yFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
    const text = this.add
      .text(px, py, `-${event.damage}`, {
        fontSize: `${14 * SCALE}px`,
        fontStyle: 'bold',
        color: '#ffe98a',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5);
    this.tweens.add({
      targets: text,
      y: py - 24 * SCALE,
      alpha: 0,
      duration: 650,
      ease: 'Cubic.Out',
      onComplete: () => text.destroy(),
    });
  }

  /** main.ts 賣塔/取消選取後也會呼叫這個,讓畫面跟資訊面板保持同步。 */
  setSelectedTower(towerId: number | null): void {
    this.selectedTowerId = towerId;
    this.onTowerSelected?.(towerId);
    if (this.pendingState && this.dynamicLayer) this.drawDynamicLayer(this.pendingState);
  }

  /** 新對局開始時呼叫:Phaser.Game 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零回左上角。 */
  resetCamera(): void {
    this.cameras.main.setScroll(0, 0);
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

    this.drawPathDirection(g);
  }

  /** 路徑上畫箭頭標出怪物前進方向,起點畫綠色圈(出生處)、終點畫紅色叉(漏怪扣血處)。 */
  private drawPathDirection(g: Phaser.GameObjects.Graphics): void {
    for (const waypoints of PATHS) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const [ax, ay] = waypoints[i];
        const [bx, by] = waypoints[i + 1];
        const dx = Math.sign(bx - ax);
        const dy = Math.sign(by - ay);
        const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
        // 每隔一格畫一個箭頭,太密會糊成一片看不清楚
        for (let s = 1; s < steps; s += 2) {
          const tx = ax + dx * s;
          const ty = ay + dy * s;
          this.drawArrow(g, tx * TILE_PX + TILE_PX / 2, ty * TILE_PX + TILE_PX / 2, dx, dy);
        }
      }

      const [startX, startY] = waypoints[0];
      const [endX, endY] = waypoints[waypoints.length - 1];
      g.fillStyle(0x3ad95a, 0.9);
      g.fillCircle(startX * TILE_PX + TILE_PX / 2, startY * TILE_PX + TILE_PX / 2, TILE_PX * 0.22);
      this.drawExitMark(g, endX * TILE_PX + TILE_PX / 2, endY * TILE_PX + TILE_PX / 2);
    }
  }

  /** 指向 (dx,dy) 方向的小箭頭(三角形),淺色跟深色土路對比清楚。 */
  private drawArrow(g: Phaser.GameObjects.Graphics, cx: number, cy: number, dx: number, dy: number): void {
    const size = TILE_PX * 0.2;
    const angle = Math.atan2(dy, dx);
    const spread = (Math.PI * 5) / 6;
    const tipX = cx + Math.cos(angle) * size;
    const tipY = cy + Math.sin(angle) * size;
    const back1X = cx + Math.cos(angle + spread) * size;
    const back1Y = cy + Math.sin(angle + spread) * size;
    const back2X = cx + Math.cos(angle - spread) * size;
    const back2Y = cy + Math.sin(angle - spread) * size;
    g.fillStyle(0xd8c9a3, 0.8);
    g.fillTriangle(tipX, tipY, back1X, back1Y, back2X, back2Y);
  }

  /** 路徑終點的紅色叉:怪物走到這裡就算漏怪扣生命。 */
  private drawExitMark(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    const size = TILE_PX * 0.2;
    g.lineStyle(3, 0xe0433a, 0.9);
    g.lineBetween(cx - size, cy - size, cx + size, cy + size);
    g.lineBetween(cx - size, cy + size, cx + size, cy - size);
  }

  /** 非路徑格灑一點樹/草叢/石頭/花/小動物,地圖比較大之後大片空草地才不會太單調。畫一次不用每 tick 重畫。 */
  private drawDecorations(): void {
    const g = this.add.graphics();
    const drawers: Array<(cx: number, cy: number, seed: number) => void> = [
      (cx, cy) => this.drawDecorTree(g, cx, cy),
      (cx, cy) => this.drawDecorBush(g, cx, cy),
      (cx, cy) => this.drawDecorRock(g, cx, cy),
      (cx, cy) => this.drawDecorFlowers(g, cx, cy),
      (cx, cy, seed) => this.drawDecorCritter(g, cx, cy, seed),
    ];
    for (let x = 0; x < GRID_WIDTH; x++) {
      for (let y = 0; y < GRID_HEIGHT; y++) {
        if (isOnPath(x, y)) continue;
        const h = tileHash(x, y);
        if (h % 100 >= DECOR_DENSITY_PERCENT) continue;
        const drawer = drawers[Math.floor(h / 100) % drawers.length];
        drawer(x * TILE_PX + TILE_PX / 2, y * TILE_PX + TILE_PX / 2, h);
      }
    }
  }

  private drawDecorTree(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 6 * SCALE, 14 * SCALE, 4 * SCALE);
    g.fillStyle(0x5b3a22, 1);
    g.fillRect(cx - 2 * SCALE, cy, 4 * SCALE, 7 * SCALE);
    g.fillStyle(0x2e6b3e, 1);
    g.fillCircle(cx, cy - 4 * SCALE, 7 * SCALE);
    g.fillStyle(0x3f8a52, 1);
    g.fillCircle(cx - 2 * SCALE, cy - 6 * SCALE, 4 * SCALE);
  }

  private drawDecorBush(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * SCALE, 14 * SCALE, 4 * SCALE);
    g.fillStyle(0x336b3a, 1);
    g.fillCircle(cx - 4 * SCALE, cy, 5 * SCALE);
    g.fillCircle(cx + 4 * SCALE, cy, 5 * SCALE);
    g.fillCircle(cx, cy - 3 * SCALE, 5.5 * SCALE);
  }

  private drawDecorRock(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * SCALE, 12 * SCALE, 3 * SCALE);
    g.fillStyle(0x6b6b6b, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(cx - 6 * SCALE, cy + 2 * SCALE),
        new Phaser.Math.Vector2(cx - 4 * SCALE, cy - 4 * SCALE),
        new Phaser.Math.Vector2(cx + 2 * SCALE, cy - 5 * SCALE),
        new Phaser.Math.Vector2(cx + 6 * SCALE, cy),
        new Phaser.Math.Vector2(cx + 3 * SCALE, cy + 4 * SCALE),
        new Phaser.Math.Vector2(cx - 2 * SCALE, cy + 5 * SCALE),
      ],
      true,
    );
    g.fillStyle(0x4a7a52, 0.5);
    g.fillCircle(cx - 2 * SCALE, cy - 3 * SCALE, 2 * SCALE);
  }

  private drawDecorFlowers(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.12);
    g.fillEllipse(cx, cy + 3 * SCALE, 10 * SCALE, 3 * SCALE);
    g.fillStyle(0x3a7d3a, 1);
    g.fillCircle(cx, cy, 4 * SCALE);
    const petalColors = [0xe86b9b, 0xf2d13d, 0xffffff];
    for (let i = 0; i < petalColors.length; i++) {
      const angle = (i / petalColors.length) * Math.PI * 2;
      g.fillStyle(petalColors[i], 1);
      g.fillCircle(cx + Math.cos(angle) * 4 * SCALE, cy + Math.sin(angle) * 4 * SCALE, 2 * SCALE);
    }
  }

  /** 小動物剪影(身體+頭+耳朵),點綴用,不對應遊戲內任何實體。 */
  private drawDecorCritter(g: Phaser.GameObjects.Graphics, cx: number, cy: number, seed: number): void {
    const flip = seed % 2 === 0 ? 1 : -1; // 用雜湊決定面朝左或右,不會整張地圖的小動物都朝同一邊
    const color = 0x8a6f4d;
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * SCALE, 10 * SCALE, 3 * SCALE);
    g.fillStyle(color, 1);
    g.fillCircle(cx, cy + 1 * SCALE, 4 * SCALE);
    g.fillCircle(cx + flip * 4 * SCALE, cy - 2 * SCALE, 2.6 * SCALE);
    g.fillTriangle(
      cx + flip * 3 * SCALE,
      cy - 4 * SCALE,
      cx + flip * 4 * SCALE,
      cy - 7 * SCALE,
      cx + flip * 5 * SCALE,
      cy - 4 * SCALE,
    );
    g.fillStyle(0x1a1a1a, 1);
    g.fillCircle(cx + flip * 5.5 * SCALE, cy - 2.5 * SCALE, 0.8 * SCALE);
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

        // 射程用紅色圓圈標示——實際判定是距離平方比較(圓形範圍),畫圓才準確反映真正打得到哪裡
        const rangePx = (TOWER_DEFS[selected.element].rangeFp / FP_SCALE) * TILE_PX;
        const cx = selected.x * TILE_PX + TILE_PX / 2;
        const cy = selected.y * TILE_PX + TILE_PX / 2;
        g.lineStyle(2, 0xe0433a, 0.7);
        g.strokeCircle(cx, cy, rangePx);
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
    const color = ELEMENT_COLORS[element];

    // 用兩層透明度遞減的圓疊出「柔光暈」,假裝出徑向漸層的立體感(Graphics 沒有原生 radial gradient fill)。
    g.fillStyle(color, 0.12);
    g.fillCircle(cx, cy, 19 * SCALE);
    g.fillStyle(color, 0.18);
    g.fillCircle(cx, cy, 13 * SCALE);

    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(cx, cy + 9 * SCALE, 22 * SCALE, 6 * SCALE);

    g.fillStyle(0x222222, 1);
    g.fillRect(cx - 10 * SCALE, cy + 2 * SCALE, 20 * SCALE, 6 * SCALE);

    g.fillStyle(color, 1);
    g.fillTriangle(cx, cy - 12 * SCALE, cx - 10 * SCALE, cy + 6 * SCALE, cx + 10 * SCALE, cy + 6 * SCALE);
    // 深色描邊讓塔身輪廓清楚,不會跟同色系的地板/光暈糊在一起
    g.lineStyle(1.5 * SCALE, 0x000000, 0.4);
    g.strokeTriangle(cx, cy - 12 * SCALE, cx - 10 * SCALE, cy + 6 * SCALE, cx + 10 * SCALE, cy + 6 * SCALE);
    // 左側一道亮邊,模擬光源從左上照過來的立體感
    g.lineStyle(1 * SCALE, 0xffffff, 0.35);
    g.lineBetween(cx, cy - 12 * SCALE, cx - 10 * SCALE, cy + 6 * SCALE);

    const pipSpacing = 5 * SCALE;
    const pipsWidth = (Math.min(level, MAX_TOWER_LEVEL) - 1) * pipSpacing;
    for (let i = 0; i < level; i++) {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(cx - pipsWidth / 2 + i * pipSpacing, cy - 17 * SCALE, 1.5 * SCALE);
    }
  }

  /** 圓身 + 小眼睛 + 頭上血條,取代原本的純色方塊。 */
  private drawMonster(g: Phaser.GameObjects.Graphics, px: number, py: number, element: Element, hpRatio: number): void {
    const color = ELEMENT_COLORS[element];

    g.fillStyle(color, 0.16);
    g.fillCircle(px, py, 10 * SCALE);

    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(px, py + 5 * SCALE, 12 * SCALE, 4 * SCALE);

    g.fillStyle(color, 1);
    g.fillCircle(px, py, 6 * SCALE);
    g.lineStyle(1 * SCALE, 0x000000, 0.35);
    g.strokeCircle(px, py, 6 * SCALE);
    // 左上角一小塊亮點當高光,打破純色圓的扁平感
    g.fillStyle(0xffffff, 0.3);
    g.fillCircle(px - 2 * SCALE, py - 2.5 * SCALE, 1.8 * SCALE);
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
