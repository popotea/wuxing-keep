// Phase 5 骨架:先用 Phaser 的 Graphics 畫幾何圖形頂著(跟原本 canvas 測試頁視覺上一致),
// 之後要換真正的圖片/精靈只需要改這個檔案內部的畫法,對外介面(renderState/onTilePlaced)不用動。

import Phaser from 'phaser';
import { GENERATED_BY, type Element } from '../sim/elements';
import {
  FP_SCALE,
  GRID_HEIGHT,
  GRID_WIDTH,
  inBounds,
  isOnPath,
  PATHS,
  VIEWPORT_TILES_H,
  VIEWPORT_TILES_W,
  worldPositionFp,
} from '../sim/map';
import type { Monster } from '../sim/monsters';
import type { SimulationState } from '../sim/simulation';
import { TOWER_DEFS, UPGRADE_PATH_LEVEL, type CombatEvent, type Tower, type UpgradePath } from '../sim/towers';
import { isMultiplayer, ownerColorHex } from './playerColors';

export const TILE_PX = 40;
// 塔/怪物的造型尺寸都是照 TILE_PX=32 時的手感調的,乘這個比例就能跟著 TILE_PX 一起放大,不用重調數字。
const SCALE = TILE_PX / 32;
// 裝飾物(樹/草叢/石頭/花/小動物)原本的幾何圖形尺寸太小、不容易看清楚,額外加一個倍率放大——
// 只用在 drawDecor*() 這幾個函式,不影響塔/怪物/HP 條等其他用到 SCALE 的地方。
const DECOR_SCALE = SCALE * 1.6;

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

// scripts/generate-decor-assets.mjs 產出的 AI 圖(見 public/assets/decor/manifest.json),
// 載入成功就優先用這些圖,任何一張缺檔/載入失敗都會自動退回下面的程序生成造型,不會整格空白。
const DECOR_IMAGE_FILES: Record<string, string> = {
  'metal-crystal': 'metal-crystal.jpg',
  'metal-fox': 'metal-fox.jpg',
  'wood-bush': 'wood-bush.jpg',
  'wood-deer': 'wood-deer.jpg',
  'water-lily': 'water-lily.jpg',
  'water-frog': 'water-frog.jpg',
  'fire-cactus': 'fire-cactus.jpg',
  'fire-salamander': 'fire-salamander.jpg',
  'earth-boulder': 'earth-boulder.jpg',
  'earth-tortoise': 'earth-tortoise.jpg',
};
const DECOR_IMAGE_KEYS = Object.keys(DECOR_IMAGE_FILES);

// tools/ai-hub 或 scripts/generate-tower-monster-assets.mjs 產出的正式美術(見 docs/ART_PIPELINE.md),
// 檔名對應 public/assets/towers|monsters/<element>.png。缺檔/載入失敗會自動退回下面的幾何圖形畫法。
const TOWER_IMAGE_FILES: Record<Element, string> = {
  metal: 'metal.png',
  wood: 'wood.png',
  water: 'water.png',
  fire: 'fire.png',
  earth: 'earth.png',
};
const MONSTER_IMAGE_FILES: Record<Element, string> = {
  metal: 'metal.png',
  wood: 'wood.png',
  water: 'water.png',
  fire: 'fire.png',
  earth: 'earth.png',
};
const TOWER_IMAGE_DISPLAY_RATIO = 0.85;
const MONSTER_IMAGE_DISPLAY_RATIO = 0.55;

function towerTextureKey(element: Element): string {
  return `tower-${element}`;
}
function monsterTextureKey(element: Element): string {
  return `monster-${element}`;
}

// scripts/generate-tower-evolution-assets.mjs 產出的升級分岐造型(見 docs/ART_PIPELINE.md)。
// 只有到 UPGRADE_PATH_LEVEL 之後選定路線的塔才會用這個,缺檔/載入失敗會退回原本的 <element>.png
// 基礎造型(不會直接跳去幾何圖形備援),levels 1~2(或選了路線前)本來就一直用基礎造型。
function towerEvolutionTextureKey(element: Element, path: UpgradePath): string {
  return `tower-${element}-${path}`;
}

// scripts/generate-terrain-assets.mjs 產出的地板/路徑材質(見 docs/ART_PIPELINE.md),
// 已經做過 seamless tiling 後處理,可以用 TileSprite 整片鋪滿不會有格線接縫。
// 缺檔/載入失敗會自動退回下面 drawStaticLayer() 原本的純色畫法。
const TILE_FLOOR_KEY = 'tile-floor';
const TILE_PATH_KEY = 'tile-path';

/** 純視覺用的簡單雜湊(不是密碼學等級),只用來決定哪幾格灑裝飾物、灑哪一種,裝飾物不是模擬狀態不用管跨機器一不一致。 */
function tileHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export class GameScene extends Phaser.Scene {
  /**
   * main.ts 在 new GameScene() 之後、Phaser boot 完成 create() 之前就會設定好這個 callback。
   * screenX/screenY 是點擊當下畫布內的像素座標(Phaser Pointer 座標,不是頁面座標),
   * main.ts 用來把浮動建造選單定位在點擊處附近(而不是固定佔用畫面底部一整塊)。
   */
  onTilePlaced: ((x: number, y: number, screenX: number, screenY: number) => void) | null = null;
  /** 選到塔(WC3 式:點塔是選取,不是直接升級)或取消選取時呼叫,null 代表沒有選取任何塔。 */
  onTowerSelected: ((towerId: number | null) => void) | null = null;

  /** 水路怪的流水視覺效果、飛行怪的地面影子——要蓋在地板材質上面、但在塔/怪物圖片下面。 */
  private groundEffectsLayer!: Phaser.GameObjects.Graphics;
  private dynamicLayer!: Phaser.GameObjects.Graphics;
  private previewLayer!: Phaser.GameObjects.Graphics;
  private minimapLayer!: Phaser.GameObjects.Graphics;
  /** 有正式美術圖時才會用到:塔/怪物各自的 Image,依 id 持久保留(不像 Graphics 每 tick 清掉重畫)。 */
  private towerSprites = new Map<number, Phaser.GameObjects.Image>();
  private monsterSprites = new Map<number, Phaser.GameObjects.Image>();
  /** 塔上方「Lv.N」文字,不管有沒有正式美術圖都會顯示(文字沒辦法用 Graphics 畫,Graphics 只能畫幾何圖形)。 */
  private towerLevelTexts = new Map<number, Phaser.GameObjects.Text>();
  private pendingState: SimulationState | null = null;
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  private selectedTowerId: number | null = null;
  /** 滑鼠是否在遊戲畫布範圍內——游標跑到畫布外的 HTML UI(HUD/塔面板)時要停止邊緣平移跟預覽。 */
  private pointerInsideCanvas = false;

  constructor() {
    super('game');
  }

  preload(): void {
    for (const key of DECOR_IMAGE_KEYS) {
      this.load.image(key, `assets/decor/${DECOR_IMAGE_FILES[key]}`);
    }
    for (const element of Object.keys(TOWER_IMAGE_FILES) as Element[]) {
      this.load.image(towerTextureKey(element), `assets/towers/${TOWER_IMAGE_FILES[element]}`);
      for (const evolutionPath of ['burst', 'splash'] as const) {
        this.load.image(towerEvolutionTextureKey(element, evolutionPath), `assets/towers/${element}-${evolutionPath}.png`);
      }
    }
    for (const element of Object.keys(MONSTER_IMAGE_FILES) as Element[]) {
      this.load.image(monsterTextureKey(element), `assets/monsters/${MONSTER_IMAGE_FILES[element]}`);
    }
    this.load.image(TILE_FLOOR_KEY, 'assets/tiles/floor.png');
    this.load.image(TILE_PATH_KEY, 'assets/tiles/path.png');
  }

  create(): void {
    this.drawStaticLayer();
    this.drawDecorations();
    // 明確指定 depth,不依賴建立順序:groundEffectsLayer(depth 0.5,水路怪的流水視覺/飛行怪
    // 的地面影子)蓋在地板/路徑材質(depth 0)上面、但在塔/怪物 Image(depth 1)下面,
    // dynamicLayer 的疊加圖層(血條/選取框/射程圈/等級光點,depth 2)再蓋在圖片上面,
    // 再上面依序是預覽格跟固定貼齊螢幕的小地圖。
    this.groundEffectsLayer = this.add.graphics().setDepth(0.5);
    this.dynamicLayer = this.add.graphics().setDepth(2);
    this.previewLayer = this.add.graphics().setDepth(3);
    this.minimapLayer = this.add.graphics().setScrollFactor(0).setDepth(4); // 固定貼在螢幕上,不隨鏡頭捲動
    // 世界(地圖)比畫布視窗大很多,鏡頭預設從左上角開始,靠邊緣平移才看得到其他區域。
    this.cameras.main.setBounds(0, 0, GRID_WIDTH * TILE_PX, GRID_HEIGHT * TILE_PX);
    this.applyViewportZoom();

    // PhaserGame.ts 用 Scale.RESIZE,畫布會跟著 #gameCanvas 的實際版面尺寸動態變動
    // (例如視窗縮放、或 CSS 版面調整撐滿可視空間)——鏡頭的可視範圍(viewport)要跟著更新,
    // 不然畫布變大了但鏡頭還是舊尺寸,會出現只畫在左上角一小塊、其餘留白的狀況。
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.cameras.main.setViewport(0, 0, gameSize.width, gameSize.height);
      this.applyViewportZoom();
    });

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
      // 陷阱/資源建築目前沒有選取面板(v1 先不做賣出/升級),但「這格已經被佔用」要交給
      // main.ts 判斷並跳提示——不要在這裡直接吞掉靜默不做事,不然玩家會搞不清楚到底是
      // 裝飾物(純視覺,不影響蓋塔)擋住了,還是這格真的已經有陷阱/資源建築。
      this.setSelectedTower(null);
      this.onTilePlaced?.(x, y, pointer.x, pointer.y);
    });

    // renderState() 可能在 Phaser 完成 boot、create() 真正執行前就先被呼叫,
    // 這時候先記住最新一份 state,create() 一跑完馬上補畫。
    if (this.pendingState) this.drawDynamicLayer(this.pendingState);
  }

  /**
   * 畫布跟著視窗尺寸滿版(Scale.RESIZE),大螢幕上畫布的實際像素會遠大於原本設計的 880x560,
   * 若鏡頭一路維持 zoom=1(1 格固定 TILE_PX 像素),大螢幕會一次看到遠超過 VIEWPORT_TILES_W/H
   * 的格數,塔/怪物相對畫面就顯得很小。改成動態算 zoom,讓畫面固定大約只看得到
   * VIEWPORT_TILES_W x VIEWPORT_TILES_H 這麼多格(取寬高比例較保守的那一邊),不管螢幕多大,
   * 物件在畫面上的相對大小都維持一致觀感,而不是螢幕越大東西看起來越小。
   */
  private applyViewportZoom(): void {
    const zoomX = this.scale.width / (VIEWPORT_TILES_W * TILE_PX);
    const zoomY = this.scale.height / (VIEWPORT_TILES_H * TILE_PX);
    this.cameras.main.setZoom(Math.max(1, Math.min(zoomX, zoomY)));
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
    // 鏡頭有 zoom 時,螢幕實際看得到的世界範圍是 cam.worldView(已經把 zoom 算進去),
    // 不能直接用 cam.width/height(那是螢幕像素,zoom!=1 時跟世界座標範圍不一樣)。
    const viewW = cam.worldView.width;
    const viewH = cam.worldView.height;
    const maxScrollX = Math.max(0, GRID_WIDTH * TILE_PX - viewW);
    const maxScrollY = Math.max(0, GRID_HEIGHT * TILE_PX - viewH);
    cam.scrollX = Phaser.Math.Clamp(worldX - viewW / 2, 0, maxScrollX);
    cam.scrollY = Phaser.Math.Clamp(worldY - viewH / 2, 0, maxScrollY);
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
      g.fillStyle(0x8a8a8a, 1);
      for (const trap of this.pendingState.traps) {
        g.fillCircle(ox + (trap.x + 0.5) * TILE_PX * MINIMAP_SCALE, oy + (trap.y + 0.5) * TILE_PX * MINIMAP_SCALE, 1.5);
      }
      g.fillStyle(0xd4af37, 1);
      for (const building of this.pendingState.resourceBuildings) {
        g.fillCircle(
          ox + (building.x + 0.5) * TILE_PX * MINIMAP_SCALE,
          oy + (building.y + 0.5) * TILE_PX * MINIMAP_SCALE,
          2,
        );
      }
      for (const m of this.pendingState.monsters) {
        const { xFp, yFp } = worldPositionFp(m.pos);
        g.fillStyle(m.isBoss ? 0xffe98a : 0xe0433a, 1);
        g.fillCircle(
          ox + (xFp / FP_SCALE) * TILE_PX * MINIMAP_SCALE,
          oy + (yFp / FP_SCALE) * TILE_PX * MINIMAP_SCALE,
          m.isBoss ? 3 : 1.5,
        );
      }
    }

    g.lineStyle(1, 0xd4af37, 0.7);
    g.strokeRect(ox, oy, w, h);

    const cam = this.cameras.main;
    g.lineStyle(1.5, 0xffffff, 0.9);
    // 白框要標示「世界座標裡實際看得到的範圍」,zoom!=1 時得用 worldView,不能直接用 cam.width/height。
    g.strokeRect(
      ox + cam.scrollX * MINIMAP_SCALE,
      oy + cam.scrollY * MINIMAP_SCALE,
      cam.worldView.width * MINIMAP_SCALE,
      cam.worldView.height * MINIMAP_SCALE,
    );
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
    // 同上,zoom!=1 時要用 worldView(世界座標範圍)而不是 cam.width/height(螢幕像素)。
    const maxScrollX = Math.max(0, GRID_WIDTH * TILE_PX - cam.worldView.width);
    const maxScrollY = Math.max(0, GRID_HEIGHT * TILE_PX - cam.worldView.height);
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

  /**
   * 新對局開始時呼叫:Phaser.Game 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零回左上角。
   * 同時清掉上一局留下的塔/怪物 Image——新對局的 id 是從頭編號的,不清掉的話舊局的 sprite
   * 可能被誤認成同 id 的新實體重複使用(貼圖沒換成新的元素)。
   */
  resetCamera(): void {
    this.cameras.main.setScroll(0, 0);
    for (const sprite of this.towerSprites.values()) sprite.destroy();
    this.towerSprites.clear();
    for (const sprite of this.monsterSprites.values()) sprite.destroy();
    this.monsterSprites.clear();
  }

  private drawStaticLayer(): void {
    const g = this.add.graphics();
    const mapWidthPx = GRID_WIDTH * TILE_PX;
    const mapHeightPx = GRID_HEIGHT * TILE_PX;

    // 有正式地板材質就整片鋪滿(材質已經做過 seamless tiling,TileSprite 重複貼不會有接縫);
    // 沒有就退回棋盤式雙色交錯畫法。地板先整片蓋住全部格子(含路徑格),路徑材質等等疊上去蓋掉。
    if (this.textures.exists(TILE_FLOOR_KEY)) {
      this.add.tileSprite(0, 0, mapWidthPx, mapHeightPx, TILE_FLOOR_KEY).setOrigin(0, 0);
    } else {
      for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
          if (isOnPath(x, y)) continue;
          g.fillStyle((x + y) % 2 === 0 ? 0x2f4d33 : 0x355a3a, 1);
          g.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        }
      }
    }

    // 路徑格各自貼一張材質圖(不是整片 TileSprite 疊 GeometryMask)——mask 每影格都要重新
    // 運算合成,路徑格一多(百來格)會拖影格率,滑鼠移動時邊緣平移/預覽格跟著卡頓。
    // 材質已經做過 seamless tiling,同一張圖照格子排就會自然接起來,靜態貼一次完全不用 mask。
    if (this.textures.exists(TILE_PATH_KEY)) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
          if (!isOnPath(x, y)) continue;
          this.add
            .image(x * TILE_PX + TILE_PX / 2, y * TILE_PX + TILE_PX / 2, TILE_PATH_KEY)
            .setDisplaySize(TILE_PX, TILE_PX);
        }
      }
    } else {
      // 路徑整格塗滿(不是只畫一條細線穿過格子中心)——這樣「這格到底算不算路徑」
      // 一眼就看得出來,不會再跟格線混在一起分不清楚可不可以蓋。
      g.fillStyle(0x6b5541, 1);
      for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
          if (isOnPath(x, y)) g.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        }
      }
    }

    // AI 生的地板/路徑材質色調偏亮、飽和度偏高,長時間盯著玩容易不舒服——疊一層半透明灰卡其色
    // 壓暗降飽和(Graphics 沒有原生調 HSL 的 API,疊色是最簡單有效的做法)。這個 Graphics 物件
    // 刻意在地板/路徑圖片都貼完之後才建立:同深度(預設 0)時疊放順序看加入順序,晚加入的蓋在
    // 上面,才不會反而被蓋在圖片底下變成完全看不到。只有真的載入了材質圖才需要壓,棋盤格/純色
    // 填滿的備援畫法本來配色就偏暗,不用再疊一次。
    if (this.textures.exists(TILE_FLOOR_KEY) || this.textures.exists(TILE_PATH_KEY)) {
      const terrainTint = this.add.graphics();
      terrainTint.fillStyle(0x4a4f3a, 0.3);
      terrainTint.fillRect(0, 0, mapWidthPx, mapHeightPx);
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
    const proceduralDrawers: Array<(cx: number, cy: number, seed: number) => void> = [
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
        const cx = x * TILE_PX + TILE_PX / 2;
        const cy = y * TILE_PX + TILE_PX / 2;
        const imageKey = DECOR_IMAGE_KEYS[Math.floor(h / 100) % DECOR_IMAGE_KEYS.length];
        if (this.textures.exists(imageKey)) {
          this.placeDecorImage(imageKey, cx, cy);
        } else {
          const drawer = proceduralDrawers[Math.floor(h / 100) % proceduralDrawers.length];
          drawer(cx, cy, h);
        }
      }
    }
  }

  /** AI 生圖沒有去背(方形草地背景),用圓形遮罩裁掉方角,看起來比較像貼在地上的裝飾物而不是一張照片。 */
  private placeDecorImage(key: string, cx: number, cy: number): void {
    const size = TILE_PX * 0.95; // 加大到接近整格,原本 0.72 太小不容易看清楚
    const image = this.add.image(cx, cy, key).setDisplaySize(size, size);
    const maskShape = this.make.graphics({}).fillStyle(0xffffff, 1).fillCircle(cx, cy, size / 2);
    image.setMask(maskShape.createGeometryMask());
  }

  private drawDecorTree(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 6 * DECOR_SCALE, 14 * DECOR_SCALE, 4 * DECOR_SCALE);
    g.fillStyle(0x5b3a22, 1);
    g.fillRect(cx - 2 * DECOR_SCALE, cy, 4 * DECOR_SCALE, 7 * DECOR_SCALE);
    g.fillStyle(0x2e6b3e, 1);
    g.fillCircle(cx, cy - 4 * DECOR_SCALE, 7 * DECOR_SCALE);
    g.fillStyle(0x3f8a52, 1);
    g.fillCircle(cx - 2 * DECOR_SCALE, cy - 6 * DECOR_SCALE, 4 * DECOR_SCALE);
  }

  private drawDecorBush(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * DECOR_SCALE, 14 * DECOR_SCALE, 4 * DECOR_SCALE);
    g.fillStyle(0x336b3a, 1);
    g.fillCircle(cx - 4 * DECOR_SCALE, cy, 5 * DECOR_SCALE);
    g.fillCircle(cx + 4 * DECOR_SCALE, cy, 5 * DECOR_SCALE);
    g.fillCircle(cx, cy - 3 * DECOR_SCALE, 5.5 * DECOR_SCALE);
  }

  private drawDecorRock(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * DECOR_SCALE, 12 * DECOR_SCALE, 3 * DECOR_SCALE);
    g.fillStyle(0x6b6b6b, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(cx - 6 * DECOR_SCALE, cy + 2 * DECOR_SCALE),
        new Phaser.Math.Vector2(cx - 4 * DECOR_SCALE, cy - 4 * DECOR_SCALE),
        new Phaser.Math.Vector2(cx + 2 * DECOR_SCALE, cy - 5 * DECOR_SCALE),
        new Phaser.Math.Vector2(cx + 6 * DECOR_SCALE, cy),
        new Phaser.Math.Vector2(cx + 3 * DECOR_SCALE, cy + 4 * DECOR_SCALE),
        new Phaser.Math.Vector2(cx - 2 * DECOR_SCALE, cy + 5 * DECOR_SCALE),
      ],
      true,
    );
    g.fillStyle(0x4a7a52, 0.5);
    g.fillCircle(cx - 2 * DECOR_SCALE, cy - 3 * DECOR_SCALE, 2 * DECOR_SCALE);
  }

  private drawDecorFlowers(g: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    g.fillStyle(0x000000, 0.12);
    g.fillEllipse(cx, cy + 3 * DECOR_SCALE, 10 * DECOR_SCALE, 3 * DECOR_SCALE);
    g.fillStyle(0x3a7d3a, 1);
    g.fillCircle(cx, cy, 4 * DECOR_SCALE);
    const petalColors = [0xe86b9b, 0xf2d13d, 0xffffff];
    for (let i = 0; i < petalColors.length; i++) {
      const angle = (i / petalColors.length) * Math.PI * 2;
      g.fillStyle(petalColors[i], 1);
      g.fillCircle(cx + Math.cos(angle) * 4 * DECOR_SCALE, cy + Math.sin(angle) * 4 * DECOR_SCALE, 2 * DECOR_SCALE);
    }
  }

  /** 小動物剪影(身體+頭+耳朵),點綴用,不對應遊戲內任何實體。 */
  private drawDecorCritter(g: Phaser.GameObjects.Graphics, cx: number, cy: number, seed: number): void {
    const flip = seed % 2 === 0 ? 1 : -1; // 用雜湊決定面朝左或右,不會整張地圖的小動物都朝同一邊
    const color = 0x8a6f4d;
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * DECOR_SCALE, 10 * DECOR_SCALE, 3 * DECOR_SCALE);
    g.fillStyle(color, 1);
    g.fillCircle(cx, cy + 1 * DECOR_SCALE, 4 * DECOR_SCALE);
    g.fillCircle(cx + flip * 4 * DECOR_SCALE, cy - 2 * DECOR_SCALE, 2.6 * DECOR_SCALE);
    g.fillTriangle(
      cx + flip * 3 * DECOR_SCALE,
      cy - 4 * DECOR_SCALE,
      cx + flip * 4 * DECOR_SCALE,
      cy - 7 * DECOR_SCALE,
      cx + flip * 5 * DECOR_SCALE,
      cy - 4 * DECOR_SCALE,
    );
    g.fillStyle(0x1a1a1a, 1);
    g.fillCircle(cx + flip * 5.5 * DECOR_SCALE, cy - 2.5 * DECOR_SCALE, 0.8 * DECOR_SCALE);
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

  /**
   * 水路怪的流水視覺效果(哪條路徑上有 'water' 移動類型的怪,整條路徑浮現半透明藍色疊加,
   * 用 sin 波輕微明暗脈動模擬水流,不是真的流動動畫,先求「看得出有水」的簡化版)+
   * 飛行怪的地面影子(暗示牠飛在空中,呼應 renderMonster 裡的懸浮位移)。
   */
  private drawGroundEffects(state: SimulationState): void {
    const g = this.groundEffectsLayer;
    g.clear();

    const wetPathIds = new Set(
      state.monsters.filter((m) => m.moveType === 'water').map((m) => m.pos.pathId),
    );
    if (wetPathIds.size > 0) {
      const pulse = 0.16 + 0.07 * Math.sin(this.time.now / 300);
      g.fillStyle(0x3a7bd5, pulse);
      for (const pathId of wetPathIds) {
        for (const [x, y] of this.tilesForPath(pathId)) {
          g.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        }
      }
    }

    for (const m of state.monsters) {
      if (m.moveType !== 'air') continue;
      const { xFp, yFp } = worldPositionFp(m.pos);
      const px = (xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      const py = (yFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      const bossMul = m.isBoss ? 1.8 : 1;
      g.fillStyle(0x000000, 0.25);
      g.fillEllipse(px, py + 3 * SCALE * bossMul, 10 * SCALE * bossMul, 4 * SCALE * bossMul);
    }
  }

  /**
   * 畫出每一對「五行相生」鄰接的塔之間的連接線(跟 towers.ts 的 hasGeneratingNeighbor() 是
   * 同一套判定規則,8 方向鄰接)。用 Set 記錄已經畫過的塔對,同一對 A-B 不會因為從 A 跟從 B
   * 各掃到一次就畫兩條重疊的線。線的顏色是「生」的那個來源元素的顏色,直覺對應「誰在滋養誰」。
   */
  private drawAdjacencyLinks(g: Phaser.GameObjects.Graphics, towers: readonly Tower[]): void {
    const drawnPairs = new Set<string>();
    for (const t of towers) {
      const sourceElement = GENERATED_BY[t.element];
      for (const other of towers) {
        if (other.id === t.id || other.element !== sourceElement) continue;
        if (Math.abs(other.x - t.x) > 1 || Math.abs(other.y - t.y) > 1) continue;
        const key = t.id < other.id ? `${t.id}-${other.id}` : `${other.id}-${t.id}`;
        if (drawnPairs.has(key)) continue;
        drawnPairs.add(key);
        const cx1 = t.x * TILE_PX + TILE_PX / 2;
        const cy1 = t.y * TILE_PX + TILE_PX / 2;
        const cx2 = other.x * TILE_PX + TILE_PX / 2;
        const cy2 = other.y * TILE_PX + TILE_PX / 2;
        g.lineStyle(2 * SCALE, ELEMENT_COLORS[sourceElement], 0.55);
        g.lineBetween(cx1, cy1, cx2, cy2);
      }
    }
  }

  /** 列出某條路徑經過的所有格子座標,跟 map.ts 的 computePathTiles() 是同一套走法,只是這裡要分開算單一路徑。 */
  private tilesForPath(pathId: number): Array<[number, number]> {
    const tiles: Array<[number, number]> = [];
    const waypoints = PATHS[pathId];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [ax, ay] = waypoints[i];
      const [bx, by] = waypoints[i + 1];
      const dx = Math.sign(bx - ax);
      const dy = Math.sign(by - ay);
      const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let s = 0; s <= steps; s++) tiles.push([ax + dx * s, ay + dy * s]);
    }
    return tiles;
  }

  private drawDynamicLayer(state: SimulationState): void {
    this.drawGroundEffects(state);
    const g = this.dynamicLayer;
    g.clear();

    // 單人模式只有自己,不需要標示「誰蓋的」;多人才需要,顏色取 ownerColorHex()(依 state.gold
    // 的 key 排序決定,所有機器算出來的顏色都一樣)。
    const multiplayer = isMultiplayer(state);

    // 五行相生鄰接加成(見 towers.ts 的 hasGeneratingNeighbor())純粹是數值效果,畫面上完全
    // 看不出來的話玩家沒辦法學會這個組合玩法,所以疊一條連接線提示「這兩座塔在互相加成」。
    // dynamicLayer 本身就是 setDepth(2),不管在函式裡多早/多晚畫都一定蓋在塔圖片(depth 1)
    // 上面,這裡刻意排在最前面純粹是不想被待會的選取白框/血條蓋住而已。
    this.drawAdjacencyLinks(g, state.towers);

    const liveTowerIds = new Set<number>();
    for (const t of state.towers) {
      liveTowerIds.add(t.id);
      this.renderTower(g, t, multiplayer ? ownerColorHex(state, t.ownerId) : null);
    }
    this.pruneStaleSprites(this.towerSprites, liveTowerIds);
    this.pruneStaleSprites(this.towerLevelTexts, liveTowerIds);

    // 陷阱/資源建築目前還沒有正式美術,先畫簡單佔位圖形(跟塔/怪物當初上正式美術前一樣的做法)。
    for (const trap of state.traps) {
      this.drawTrap(g, trap.x, trap.y, multiplayer ? ownerColorHex(state, trap.ownerId) : null);
    }
    for (const building of state.resourceBuildings) {
      this.drawResourceBuilding(g, building.x, building.y, multiplayer ? ownerColorHex(state, building.ownerId) : null);
    }

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

    const liveMonsterIds = new Set<number>();
    for (const m of state.monsters) {
      liveMonsterIds.add(m.id);
      this.renderMonster(g, m);
    }
    this.pruneStaleSprites(this.monsterSprites, liveMonsterIds);
  }

  /** state 裡已經不存在的 id(賣掉的塔、死掉/走出地圖的怪物)要把對應的 GameObject 銷毀,不然會一直留在畫面上。 */
  private pruneStaleSprites<T extends { destroy(): void }>(sprites: Map<number, T>, liveIds: Set<number>): void {
    for (const [id, sprite] of sprites) {
      if (liveIds.has(id)) continue;
      sprite.destroy();
      sprites.delete(id);
    }
  }

  /**
   * 決定這座塔目前該用哪張圖:選了路線且到分岐級以上,優先用該路線的強化造型;
   * 沒有強化造型(還沒產圖/載入失敗)就退回基礎造型;基礎造型也沒有就回傳 null
   * 讓呼叫端退回幾何圖形畫法。三層備援都不會整格空白。
   */
  private resolveTowerTextureKey(t: Tower): string | null {
    if (t.level >= UPGRADE_PATH_LEVEL && t.upgradePath !== 'none') {
      const evolvedKey = towerEvolutionTextureKey(t.element, t.upgradePath);
      if (this.textures.exists(evolvedKey)) return evolvedKey;
    }
    const baseKey = towerTextureKey(t.element);
    return this.textures.exists(baseKey) ? baseKey : null;
  }

  /**
   * 有正式美術圖就用 Image 顯示(位置不變,只需要更新等級光點/強化造型);沒有就退回原本的幾何圖形畫法。
   * ownerMark 是多人模式下這座塔主人配到的識別色(單人模式傳 null,不畫)。
   */
  private renderTower(g: Phaser.GameObjects.Graphics, t: Tower, ownerMark: number | null): void {
    const key = this.resolveTowerTextureKey(t);
    if (!key) {
      this.towerSprites.get(t.id)?.destroy();
      this.towerSprites.delete(t.id);
      this.drawTower(g, t.id, t.x, t.y, t.element, t.level, ownerMark);
      return;
    }
    const cx = t.x * TILE_PX + TILE_PX / 2;
    const cy = t.y * TILE_PX + TILE_PX / 2;
    // 選了路線的強化造型額外放大一點,搭配造型本身的變化,讓「升級後更強」更有感覺。
    const evolved = t.level >= UPGRADE_PATH_LEVEL && t.upgradePath !== 'none';
    const displaySize = TILE_PX * TOWER_IMAGE_DISPLAY_RATIO * (evolved ? 1.15 : 1);
    let sprite = this.towerSprites.get(t.id);
    if (!sprite) {
      sprite = this.add.image(cx, cy, key).setDepth(1);
      this.towerSprites.set(t.id, sprite);
    }
    sprite.setTexture(key).setPosition(cx, cy).setDisplaySize(displaySize, displaySize);
    this.drawOwnerMark(g, cx, cy, ownerMark);
    this.drawTowerLevelLabel(t.id, cx, cy, t.level);
  }

  /** 多人模式下在建築底部畫一圈識別色橢圓,一眼看出這是誰蓋的;單人模式/顏色為 null 時不畫。 */
  private drawOwnerMark(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ownerMark: number | null): void {
    if (ownerMark === null) return;
    g.lineStyle(2.5 * SCALE, ownerMark, 0.95);
    g.strokeEllipse(cx, cy + 9 * SCALE, 22 * SCALE, 6 * SCALE);
  }

  /**
   * 塔正上方的「Lv.N」文字,取代原本純點狀的等級指示——文字比數點數直接好讀,尤其升到
   * 高等級之後一排點也不好一眼數清楚。文字沒辦法用 Graphics 畫(Graphics 只能畫幾何圖形),
   * 所以用 Phaser.GameObjects.Text,依 id 建立/更新/銷毀,跟 towerSprites 走同一套模式。
   */
  private drawTowerLevelLabel(id: number, cx: number, cy: number, level: number): void {
    const y = cy - TILE_PX / 2 - 4 * SCALE;
    let label = this.towerLevelTexts.get(id);
    if (!label) {
      label = this.add
        .text(cx, y, '', {
          fontSize: `${11 * SCALE}px`,
          fontFamily: '"Microsoft JhengHei", sans-serif',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 2 * SCALE,
        })
        .setOrigin(0.5, 1)
        .setDepth(2);
      this.towerLevelTexts.set(id, label);
    }
    label.setPosition(cx, y).setText(`Lv.${level}`);
  }

  /**
   * 有正式美術圖就用 Image 顯示(每 tick 更新位置/縮放);沒有就退回原本的幾何圖形畫法。
   * 飛行怪的圖(跟血條/首領框一起)整隻往上位移一點,配合 drawGroundEffects() 畫的地面
   * 影子,製造出「飛在空中」的感覺——實際戰鬥判定的座標(m.pos)完全不受這個視覺位移影響。
   */
  private renderMonster(g: Phaser.GameObjects.Graphics, m: Monster): void {
    const { xFp, yFp } = worldPositionFp(m.pos);
    const px = (xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
    const py = (yFp / FP_SCALE) * TILE_PX + TILE_PX / 2 - (m.moveType === 'air' ? 8 * SCALE : 0);
    const hpRatio = m.hp / m.maxHp;
    const key = monsterTextureKey(m.element);
    if (!this.textures.exists(key)) {
      this.monsterSprites.get(m.id)?.destroy();
      this.monsterSprites.delete(m.id);
      this.drawMonster(g, px, py, m.element, hpRatio, m.isBoss);
      return;
    }
    const bossMul = m.isBoss ? 1.8 : 1;
    let sprite = this.monsterSprites.get(m.id);
    if (!sprite) {
      sprite = this.add.image(px, py, key).setDepth(1);
      this.monsterSprites.set(m.id, sprite);
    }
    sprite
      .setTexture(key)
      .setPosition(px, py)
      .setDisplaySize(TILE_PX * MONSTER_IMAGE_DISPLAY_RATIO * bossMul, TILE_PX * MONSTER_IMAGE_DISPLAY_RATIO * bossMul);
    this.drawMonsterOverlay(g, px, py, hpRatio, m.isBoss, bossMul);
  }

  /** 血條 + 首領金框,圖片版跟幾何圖形版共用同一個畫法(幾何圖形版的身體本身也另外畫在 drawMonster 裡)。 */
  private drawMonsterOverlay(
    g: Phaser.GameObjects.Graphics,
    px: number,
    py: number,
    hpRatio: number,
    isBoss: boolean,
    bossMul: number,
  ): void {
    if (isBoss) {
      g.lineStyle(1.5 * SCALE, 0xffe98a, 0.85);
      g.strokeCircle(px, py, 8 * SCALE * bossMul);
    }
    const ratio = Math.max(0, Math.min(1, hpRatio));
    const barColor = ratio > 0.5 ? 0x3a9d3a : ratio > 0.25 ? 0xd4af37 : 0xe05a2b;
    const barW = 16 * SCALE * bossMul;
    const barH = 3 * SCALE;
    g.fillStyle(0x000000, 0.6);
    g.fillRect(px - barW / 2, py - 12 * SCALE * bossMul, barW, barH);
    g.fillStyle(barColor, 1);
    g.fillRect(px - barW / 2, py - 12 * SCALE * bossMul, barW * ratio, barH);
  }

  /** 陷阱目前沒有正式美術,先畫一排小尖刺(壓力板/地刺的感覺),蓋在路徑格材質上面。 */
  private drawTrap(g: Phaser.GameObjects.Graphics, gridX: number, gridY: number, ownerMark: number | null): void {
    const cx = gridX * TILE_PX + TILE_PX / 2;
    const cy = gridY * TILE_PX + TILE_PX / 2;
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(cx, cy + 4 * SCALE, 24 * SCALE, 8 * SCALE);
    g.fillStyle(0x8a8a8a, 1);
    for (let i = -1; i <= 1; i++) {
      const spikeX = cx + i * 8 * SCALE;
      g.fillTriangle(spikeX - 4 * SCALE, cy + 6 * SCALE, spikeX, cy - 8 * SCALE, spikeX + 4 * SCALE, cy + 6 * SCALE);
    }
    g.lineStyle(1 * SCALE, 0x000000, 0.4);
    g.strokeCircle(cx, cy, 15 * SCALE);
    this.drawOwnerMark(g, cx, cy + 4 * SCALE, ownerMark);
  }

  /** 資源建築目前沒有正式美術,先畫一個金色屋頂的小房子造型。 */
  private drawResourceBuilding(g: Phaser.GameObjects.Graphics, gridX: number, gridY: number, ownerMark: number | null): void {
    const cx = gridX * TILE_PX + TILE_PX / 2;
    const cy = gridY * TILE_PX + TILE_PX / 2;
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(cx, cy + 9 * SCALE, 22 * SCALE, 6 * SCALE);
    g.fillStyle(0x3a6b4a, 1);
    g.fillRect(cx - 9 * SCALE, cy - 2 * SCALE, 18 * SCALE, 10 * SCALE);
    g.fillStyle(0xd4af37, 1);
    g.fillTriangle(cx - 11 * SCALE, cy - 2 * SCALE, cx, cy - 14 * SCALE, cx + 11 * SCALE, cy - 2 * SCALE);
    g.lineStyle(1 * SCALE, 0x000000, 0.35);
    g.strokeTriangle(cx - 11 * SCALE, cy - 2 * SCALE, cx, cy - 14 * SCALE, cx + 11 * SCALE, cy - 2 * SCALE);
    this.drawOwnerMark(g, cx, cy, ownerMark);
  }

  /** 底座 + 尖塔的簡易造型,比純色圓形更有辨識度;等級用塔尖上方的「Lv.N」文字表示。沒有正式美術圖時的備援畫法。 */
  private drawTower(
    g: Phaser.GameObjects.Graphics,
    id: number,
    gridX: number,
    gridY: number,
    element: Element,
    level: number,
    ownerMark: number | null,
  ): void {
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

    this.drawOwnerMark(g, cx, cy, ownerMark);
    this.drawTowerLevelLabel(id, cx, cy, level);
  }

  /** 圓身 + 小眼睛 + 頭上血條。首領怪(isBoss)整隻放大 1.8 倍再加一圈金框。沒有正式美術圖時的備援畫法。 */
  private drawMonster(
    g: Phaser.GameObjects.Graphics,
    px: number,
    py: number,
    element: Element,
    hpRatio: number,
    isBoss: boolean,
  ): void {
    const color = ELEMENT_COLORS[element];
    const bossMul = isBoss ? 1.8 : 1;

    g.fillStyle(color, 0.16);
    g.fillCircle(px, py, 10 * SCALE * bossMul);

    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(px, py + 5 * SCALE * bossMul, 12 * SCALE * bossMul, 4 * SCALE * bossMul);

    g.fillStyle(color, 1);
    g.fillCircle(px, py, 6 * SCALE * bossMul);
    g.lineStyle(1 * SCALE, 0x000000, 0.35);
    g.strokeCircle(px, py, 6 * SCALE * bossMul);
    if (isBoss) {
      // 首領怪額外一圈脈動感的金框,遠遠就看得出跟一般小怪不一樣
      g.lineStyle(1.5 * SCALE, 0xffe98a, 0.85);
      g.strokeCircle(px, py, 8 * SCALE * bossMul);
    }
    // 左上角一小塊亮點當高光,打破純色圓的扁平感
    g.fillStyle(0xffffff, 0.3);
    g.fillCircle(px - 2 * SCALE * bossMul, py - 2.5 * SCALE * bossMul, 1.8 * SCALE * bossMul);
    g.fillStyle(0x1a1a1a, 1);
    g.fillCircle(px + 2 * SCALE * bossMul, py - 2 * SCALE * bossMul, 1.5 * SCALE * bossMul);

    const ratio = Math.max(0, Math.min(1, hpRatio));
    const barColor = ratio > 0.5 ? 0x3a9d3a : ratio > 0.25 ? 0xd4af37 : 0xe05a2b;
    const barW = 16 * SCALE * bossMul;
    const barH = 3 * SCALE;
    g.fillStyle(0x000000, 0.6);
    g.fillRect(px - barW / 2, py - 12 * SCALE * bossMul, barW, barH);
    g.fillStyle(barColor, 1);
    g.fillRect(px - barW / 2, py - 12 * SCALE * bossMul, barW * ratio, barH);
  }
}
