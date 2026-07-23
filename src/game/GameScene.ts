// Phase 5 骨架:先用 Phaser 的 Graphics 畫幾何圖形頂著(跟原本 canvas 測試頁視覺上一致),
// 之後要換真正的圖片/精靈只需要改這個檔案內部的畫法,對外介面(renderState/onTilePlaced)不用動。

import Phaser from 'phaser';
import { ELEMENT_NAMES, GENERATED_BY, type Element } from '../sim/elements';
import {
  activeMapDefId,
  FP_SCALE,
  GRID_HEIGHT,
  GRID_WIDTH,
  inBounds,
  isOnPath,
  MAP_DEFS,
  paths,
  worldPositionFp,
} from '../sim/map';
import type { Monster } from '../sim/monsters';
import { RUNE_TOTEM_RANGE_FP } from '../sim/placements';
import { STATUS_NAMES, type StatusKind } from '../sim/statuses';
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
// 這是桌面版的縮小倍率上限,手機直式螢幕畫布很小時會再往下縮(見 GameScene.minimapScale),
// 不然固定 0.1 倍算出來的小地圖在小畫布上會佔掉快一半畫面,喧賓奪主。
const MINIMAP_SCALE_MAX = 0.1;
/** 小地圖大小最多佔畫布這個比例(寬高分別算,取比較保守的一邊),避免小畫布上小地圖過大。 */
const MINIMAP_MAX_CANVAS_RATIO = 0.2;
const MINIMAP_MARGIN_PX = 8;

const ELEMENT_COLORS: Record<Element, number> = {
  metal: 0xd4af37,
  wood: 0x3a9d3a,
  water: 0x3a7bd5,
  fire: 0xe05a2b,
  earth: 0xa67c3d,
};

/**
 * 怪物中了異常狀態時整隻染上的顏色(見 sim/statuses.ts)。同時中多個狀態時只顯示一種——
 * 依「玩家最需要一眼看到的」排序:纏繞(完全停住)> 冰緩(明顯變慢)> 破甲(輸出翻倍的機會)
 * > 灼燒(持續掉血,血條本來就看得到)。沒有狀態回傳 null,呼叫端要記得把 tint 清回白色。
 */
function statusTintColor(m: Monster): number | null {
  if (m.statusEntangleTicks > 0) return 0x7ee08a; // 纏繞:藤蔓綠
  if (m.statusChillTicks > 0) return 0x8ecdff; // 冰緩:冰藍
  if (m.statusSunderTicks > 0) return 0xffd27e; // 破甲:護甲碎裂的暖黃
  if (m.statusBurnTicks > 0) return 0xff9b6b; // 灼燒:火橘
  return null;
}

/** 飄動狀態名稱的文字顏色,跟 statusTintColor 的染色是同一套配色,兩邊看到的顏色一致。 */
const STATUS_TEXT_COLORS: Record<StatusKind, string> = {
  burn: '#ff9b6b',
  chill: '#8ecdff',
  entangle: '#7ee08a',
  sunder: '#ffd27e',
  knockback: '#ffffff',
};

/** 主動技能施放特效的顏色(見 sim/skills.ts)。 */
const SKILL_EFFECT_COLORS: Record<string, number> = {
  meteor: 0xff7a3c, // 隕石:火橘
  frost: 0x8ecdff, // 寒冰:冰藍
  warcry: 0xffe98a, // 戰吼:增益金
};

/** 有特殊能力的怪身上多畫一圈環的顏色(見 sim/monsters.ts 的 MonsterAbility);一般怪不畫。 */
const ABILITY_RING_COLORS: Partial<Record<Monster['ability'], number>> = {
  healer: 0x7ee08a, // 治療兵:回復綠
  shield: 0x6ec6ff, // 護盾兵:護盾藍
  splitter: 0xc98aff, // 分裂怪:分裂紫
  aura: 0xffe98a, // 急行光環:加速黃
  bomber: 0xff6b6b, // 爆破兵:警告紅
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

/**
 * 每張地圖各自的地形材質(scripts/generate-map-terrain-assets.mjs 產的),讓三張地圖一眼
 * 看得出是不同場景——原本三張共用同一套草地+土路,只有路徑形狀不同,視覺上分不出來。
 *
 * **三層備援**(跟塔的 resolveTowerTextureKey() 同一套精神):
 *   地圖專屬材質 → 共用的 tiles/floor.png|path.png → 純色棋盤格/純色填滿
 * 所以只有部分地圖有專屬材質也不會壞(`crossroads` 就刻意沒產,它用的就是共用那組——
 * 那組已經過一輪「太亮太飽和」的調校,重產反而可能退步)。
 */
function mapTileKey(mapId: string, kind: 'floor' | 'path'): string {
  return `tile-${kind}-${mapId}`;
}

/**
 * 地形疊色(壓暗降飽和)。AI 生的材質色調普遍偏亮偏飽和,長時間盯著玩不舒服,
 * 疊一層半透明色壓下來——但**不同主題要疊不同顏色**:雪原疊灰卡其會變成髒黃色,
 * 沙漠疊冷色會變得死氣沉沉。沒列在表裡的地圖走 DEFAULT(原本的灰卡其)。
 */
const TERRAIN_TINT_DEFAULT = { color: 0x4a4f3a, alpha: 0.3 };
const TERRAIN_TINT_BY_MAP: Record<string, { color: number; alpha: number }> = {
  crossroads: { color: 0x4a4f3a, alpha: 0.3 }, // 草原:原本調校過的灰卡其
  serpent: { color: 0x5a4a35, alpha: 0.26 }, // 沙漠:暖褐,保留一點乾燥感
  trident: { color: 0x3f4a5a, alpha: 0.26 }, // 雪原:冷灰藍,壓亮度但不弄髒白色
};

/**
 * 每張地圖的裝飾物主題。`useAiImages` 只有草原地圖是 true——AI 生的裝飾圖沒有去背、
 * 帶著綠色草地方形背景,鋪在沙漠/雪原上會變成一格格突兀的綠色補丁。
 * `kinds` 決定用哪幾種程序生成造型,`foliage`/`trunk`/`rock` 是配色。
 */
interface DecorTheme {
  useAiImages: boolean;
  kinds: readonly string[];
  foliage: number;
  trunk: number;
  rock: number;
}

const DECOR_THEME_DEFAULT: DecorTheme = {
  useAiImages: true,
  kinds: ['tree', 'bush', 'rock', 'flowers', 'critter'],
  foliage: 0x3f7a3f,
  trunk: 0x6b4a2f,
  rock: 0x7a7a72,
};

const DECOR_THEME_BY_MAP: Record<string, DecorTheme> = {
  crossroads: DECOR_THEME_DEFAULT,
  // 沙漠:沒有樹,只有石頭跟乾枯的灌木,配色偏黃褐
  serpent: {
    useAiImages: false,
    kinds: ['rock', 'bush', 'rock'],
    foliage: 0x8a7a45,
    trunk: 0x7a5c38,
    rock: 0x9a8259,
  },
  // 雪原:枯樹 + 石頭,配色偏冷灰
  trident: {
    useAiImages: false,
    kinds: ['rock', 'tree', 'rock'],
    foliage: 0x8fa3ad,
    trunk: 0x5f5348,
    rock: 0x9aa6ad,
  },
};

/** 有專屬材質就用專屬的,否則退回共用的;兩個都沒載入成功回傳 null(呼叫端退回純色畫法)。 */
function resolveTileKey(mapId: string, kind: 'floor' | 'path', scene: Phaser.Scene): string | null {
  const specific = mapTileKey(mapId, kind);
  if (scene.textures.exists(specific)) return specific;
  const shared = kind === 'floor' ? TILE_FLOOR_KEY : TILE_PATH_KEY;
  return scene.textures.exists(shared) ? shared : null;
}

/** 把顏色往白色拉一點(amount 0~1),用來從主色算出高光色,不用每個主題都手動配兩個顏色。 */
function lighten(color: number, amount: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) + 255 * amount));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) + 255 * amount));
  const b = Math.min(255, Math.round((color & 0xff) + 255 * amount));
  return (r << 16) | (g << 8) | b;
}

/** 純視覺用的簡單雜湊(不是密碼學等級),只用來決定哪幾格灑裝飾物、灑哪一種,裝飾物不是模擬狀態不用管跨機器一不一致。 */
function tileHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 滑鼠目前停在哪個物件上面(塔/怪物/陷阱/資源建築),main.ts 靠這個決定要不要顯示浮動說明。 */
export interface HoverInfo {
  kind: 'tower' | 'monster' | 'trap' | 'resourceBuilding' | 'runeTotem';
  id: number;
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
  /**
   * 滑鼠移到塔/怪物/陷阱/資源建築上面(或移開)時呼叫,每影格都會重算並呼叫一次(不只在
   * 「換了一個不同物件」時才呼叫)——不是浪費,塔本身資訊不常變但怪物血量之類的數值持續在
   * 變,main.ts 的浮動說明要能跟著即時更新,不能只在「切換到別的物件」才重畫。null 代表滑鼠
   * 沒有停在任何物件上面(main.ts 收到 null 要把浮動說明藏起來)。screenX/screenY 同上。
   */
  onHoverInfoChanged: ((info: HoverInfo | null, screenX: number, screenY: number) => void) | null = null;

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
  /** 陷阱上方「Lv.N」文字,獨立一個 Map——塔跟陷阱的 id 是各自獨立的計數器,兩邊都從 1 開始編號,
   * 共用同一個 Map 依 id 存取的話會撞號互相覆蓋/誤刪。 */
  private trapLevelTexts = new Map<number, Phaser.GameObjects.Text>();
  /** 怪物頭上顯示元素名稱的文字,依 id 建立/更新/銷毀,跟 monsterSprites 走同一套模式。 */
  private monsterNameTexts = new Map<number, Phaser.GameObjects.Text>();
  /** 符文圖騰上方「Lv.N」文字,獨立一個 Map(理由同 trapLevelTexts,id 計數器各自獨立)。 */
  private totemLevelTexts = new Map<number, Phaser.GameObjects.Text>();
  private pendingState: SimulationState | null = null;
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  private selectedTowerId: number | null = null;
  /** 滑鼠是否在遊戲畫布範圍內——游標跑到畫布外的 HTML UI(HUD/塔面板)時要停止邊緣平移跟預覽。 */
  private pointerInsideCanvas = false;
  /** 小地圖實際使用的縮小倍率,每次 applyViewportZoom() 依畫布尺寸重算,見 MINIMAP_MAX_CANVAS_RATIO。 */
  private minimapScale = MINIMAP_SCALE_MAX;
  /**
   * 靜態層(地板/路徑/描邊/格線/裝飾物)建立出來的所有 GameObject。
   * 這些東西原本只在 create() 畫一次就不管了,但**多地圖之後每場對局的路徑形狀可能不一樣**,
   * 換地圖就得整個重畫——追蹤起來才有辦法在重畫前把上一張地圖的殘留物件清乾淨
   * (不清的話新舊路徑會疊在一起,畫面上看得到兩張地圖的路徑)。
   */
  private staticObjects: Phaser.GameObjects.GameObject[] = [];

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
    // 每張地圖的專屬地形材質。preload 只在整個網頁生命週期跑一次(Phaser.Game 跨對局重複
    // 使用),沒辦法等玩家選了地圖才載——所以一次把所有地圖的都載進來。材質是 256x256,
    // 全部加起來也才幾百 KB,不值得為了省這點流量去搞動態 loader。
    //
    // **每張地圖都要有實際檔案存在**:Phaser 的 loader 載不到檔會往 console 噴 error
    // (「Failed to process file: image tile-floor-xxx」),雖然 resolveTileKey() 會正常
    // 退回共用材質、功能不受影響,但主控台一直有紅字很干擾排查真正的問題。crossroads 因此
    // 直接複製了一份共用材質到 tiles/crossroads/(它的材質已經過調校,不重新產)。
    // resolveTileKey() 的備援路徑仍然留著當保險,不是拿掉。
    for (const def of MAP_DEFS) {
      this.load.image(mapTileKey(def.id, 'floor'), `assets/tiles/${def.id}/floor.png`);
      this.load.image(mapTileKey(def.id, 'path'), `assets/tiles/${def.id}/path.png`);
    }
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
      this.onHoverInfoChanged?.(null, 0, 0);
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
   * 一開始用「固定只看得到 VIEWPORT_TILES_W x VIEWPORT_TILES_H 格,滑鼠貼邊緣平移鏡頭」
   * (世紀帝國式),但滑鼠不好操作平移這件事本身,改成乾脆縮放到整張地圖(GRID_WIDTH x
   * GRID_HEIGHT)一次全部塞進畫布,不管螢幕多大都直接看到全圖,不用平移鏡頭
   * (2026-07-16 改的)。取寬高比例較保守的那一邊,確保地圖完整塞得下不會被裁掉。
   * 這樣一來 update() 裡的邊緣平移計算會自動變成 no-op(maxScrollX/Y 算出來就是 0,
   * 因為 worldView 已經跟整張地圖一樣大或更大),不用另外刪那段程式碼。
   *
   * **2026-07-21 手機直式螢幕的置中問題,改在 CSS 解決,不是這裡**:縮放取「較保守的那一邊」
   * 代表另一軸的視野通常會比地圖大(例如手機直式畫布很窄很高,地圖是 40x24 橫向比例),曾經
   * 嘗試在這個函式裡用 scrollX/scrollY 或 setViewport 手動置中那一軸,但這個版本的 Phaser
   * (4.2.1)在 zoom!=1 時,useBounds 的內建 clampX/clampY 跟 setViewport+setZoom 的疊加計算
   * 都對不太上(實測會把手動置中的結果整個蓋掉,或算出跟預期不符的縮放結果),換了好幾種寫法
   * 都繞不過去。改成從根源避免「視野比地圖大」這個情況發生:`index.html` 的 `#gameCanvasWrap`
   * 用 `aspect-ratio` 固定成跟地圖一樣的比例(GRID_WIDTH:GRID_HEIGHT),讓縮放後的畫布尺寸
   * 永遠跟地圖同比例,zoomX 恆等於 zoomY,不會有任何一軸留白——這裡維持原本最簡單的寫法就好。
   */
  private applyViewportZoom(): void {
    const zoomX = this.scale.width / (GRID_WIDTH * TILE_PX);
    const zoomY = this.scale.height / (GRID_HEIGHT * TILE_PX);
    this.cameras.main.setZoom(Math.min(zoomX, zoomY));
    // 小地圖固定像素大小(MINIMAP_SCALE_MAX 倍率)在桌面版夠小夠不起眼,但手機直式畫布本身
    // 就很小,固定倍率算出來的小地圖會佔掉快一半畫面——夾在「最多佔畫布 MINIMAP_MAX_CANVAS_RATIO
    // 比例」跟桌面倍率之間取較小值,小畫布上自動縮得更小,大畫布上維持原本手感不變。
    const maxByWidth = (this.scale.width * MINIMAP_MAX_CANVAS_RATIO) / (GRID_WIDTH * TILE_PX);
    const maxByHeight = (this.scale.height * MINIMAP_MAX_CANVAS_RATIO) / (GRID_HEIGHT * TILE_PX);
    this.minimapScale = Math.min(MINIMAP_SCALE_MAX, maxByWidth, maxByHeight);
  }

  /** 小地圖左上角在螢幕座標系(scrollFactor=0)裡的位置,固定貼在畫布右下角。 */
  private minimapOrigin(): { x: number; y: number } {
    const w = GRID_WIDTH * TILE_PX * this.minimapScale;
    const h = GRID_HEIGHT * TILE_PX * this.minimapScale;
    return { x: this.scale.width - w - MINIMAP_MARGIN_PX, y: this.scale.height - h - MINIMAP_MARGIN_PX };
  }

  /** 點在小地圖範圍內就把主鏡頭跳過去(以點擊處為中心),回傳 true 代表這次點擊已經處理掉、不用再當成蓋塔/選塔。 */
  private jumpCameraFromMinimapClick(pointer: Phaser.Input.Pointer): boolean {
    const { x: ox, y: oy } = this.minimapOrigin();
    const w = GRID_WIDTH * TILE_PX * this.minimapScale;
    const h = GRID_HEIGHT * TILE_PX * this.minimapScale;
    if (pointer.x < ox || pointer.x > ox + w || pointer.y < oy || pointer.y > oy + h) return false;

    const worldX = (pointer.x - ox) / this.minimapScale;
    const worldY = (pointer.y - oy) / this.minimapScale;
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
    const w = GRID_WIDTH * TILE_PX * this.minimapScale;
    const h = GRID_HEIGHT * TILE_PX * this.minimapScale;

    g.fillStyle(0x0b0d10, 0.75);
    g.fillRect(ox, oy, w, h);

    g.fillStyle(0x6b5541, 0.9);
    for (const waypoints of paths()) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const [ax, ay] = waypoints[i];
        const [bx, by] = waypoints[i + 1];
        g.fillRect(
          ox + Math.min(ax, bx) * TILE_PX * this.minimapScale,
          oy + Math.min(ay, by) * TILE_PX * this.minimapScale,
          (Math.abs(bx - ax) + 1) * TILE_PX * this.minimapScale,
          (Math.abs(by - ay) + 1) * TILE_PX * this.minimapScale,
        );
      }
    }

    if (this.pendingState) {
      for (const t of this.pendingState.towers) {
        g.fillStyle(ELEMENT_COLORS[t.element], 1);
        g.fillCircle(ox + (t.x + 0.5) * TILE_PX * this.minimapScale, oy + (t.y + 0.5) * TILE_PX * this.minimapScale, 2);
      }
      g.fillStyle(0x8a8a8a, 1);
      for (const trap of this.pendingState.traps) {
        g.fillCircle(ox + (trap.x + 0.5) * TILE_PX * this.minimapScale, oy + (trap.y + 0.5) * TILE_PX * this.minimapScale, 1.5);
      }
      g.fillStyle(0xd4af37, 1);
      for (const building of this.pendingState.resourceBuildings) {
        g.fillCircle(
          ox + (building.x + 0.5) * TILE_PX * this.minimapScale,
          oy + (building.y + 0.5) * TILE_PX * this.minimapScale,
          2,
        );
      }
      for (const m of this.pendingState.monsters) {
        const { xFp, yFp } = worldPositionFp(m.pos);
        g.fillStyle(m.isBoss ? 0xffe98a : 0xe0433a, 1);
        g.fillCircle(
          ox + (xFp / FP_SCALE) * TILE_PX * this.minimapScale,
          oy + (yFp / FP_SCALE) * TILE_PX * this.minimapScale,
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
      ox + cam.scrollX * this.minimapScale,
      oy + cam.scrollY * this.minimapScale,
      cam.worldView.width * this.minimapScale,
      cam.worldView.height * this.minimapScale,
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

  /**
   * 滑鼠目前停在哪個物件上面,給 main.ts 顯示浮動說明用。怪物不像塔/陷阱固定在格子中心,
   * 用「格子座標一樣」比對會抓不到(怪物走在路徑上,位置是連續的像素座標),改成拿滑鼠的
   * 世界座標跟每隻怪物實際畫面位置比距離平方,抓門檻內最近的一隻;怪物優先於同格的塔/
   * 陷阱(陷阱蓋在路徑格,怪物走過去時兩者會疊在一起,滑鼠停在那邊通常是想看怪物資訊)。
   */
  private computeHoverInfo(pointer: Phaser.Input.Pointer): HoverInfo | null {
    if (!this.pendingState) return null;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);

    const hoverRadiusSq = (TILE_PX * 0.4) * (TILE_PX * 0.4);
    let closestMonster: Monster | null = null;
    let closestDistSq = Infinity;
    for (const m of this.pendingState.monsters) {
      const { xFp, yFp } = worldPositionFp(m.pos);
      const px = (xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
      const py = (yFp / FP_SCALE) * TILE_PX + TILE_PX / 2 - (m.moveType === 'air' ? 8 * SCALE : 0);
      const dx = px - world.x;
      const dy = py - world.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= hoverRadiusSq && distSq < closestDistSq) {
        closestDistSq = distSq;
        closestMonster = m;
      }
    }
    if (closestMonster) return { kind: 'monster', id: closestMonster.id };

    const gridX = Math.floor(world.x / TILE_PX);
    const gridY = Math.floor(world.y / TILE_PX);
    const tower = this.pendingState.towers.find((t) => t.x === gridX && t.y === gridY);
    if (tower) return { kind: 'tower', id: tower.id };
    const trap = this.pendingState.traps.find((t) => t.x === gridX && t.y === gridY);
    if (trap) return { kind: 'trap', id: trap.id };
    const building = this.pendingState.resourceBuildings.find((b) => b.x === gridX && b.y === gridY);
    if (building) return { kind: 'resourceBuilding', id: building.id };
    const totem = this.pendingState.runeTotems.find((r) => r.x === gridX && r.y === gridY);
    if (totem) return { kind: 'runeTotem', id: totem.id };
    return null;
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
    this.onHoverInfoChanged?.(this.computeHoverInfo(pointer), pointer.x, pointer.y);

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
      for (const cast of state.skillCasts) this.spawnSkillEffect(cast);
    }
    if (this.previewLayer) this.drawPreview();
  }

  /** 打中怪物時飄出一個往上淡出的傷害數字,不用等真的做出命中特效素材前先有基本回饋感。 */
  private spawnDamageNumber(event: CombatEvent): void {
    const px = (event.xFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
    const py = (event.yFp / FP_SCALE) * TILE_PX + TILE_PX / 2;
    // 被護盾吸收掉的那部分用藍色另外標出來,玩家才知道「傷害有進去,只是被護盾擋了」,
    // 不會誤以為自己的塔打不動這隻怪(見 sim/monsters.ts 的 shield 能力)。
    const label = event.absorbedByShield ? `-${event.damage} (盾${event.absorbedByShield})` : `-${event.damage}`;
    const color = event.absorbedByShield ? '#8ecdff' : event.status === 'burn' ? '#ff9b6b' : '#ffe98a';
    const text = this.add
      .text(px, py, label, {
        fontSize: `${14 * SCALE}px`,
        fontStyle: 'bold',
        color,
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(3);
    this.tweens.add({
      targets: text,
      y: py - 24 * SCALE,
      alpha: 0,
      duration: 650,
      ease: 'Cubic.Out',
      onComplete: () => text.destroy(),
    });

    // 這一擊順便附加了異常狀態的話,另外飄一個狀態名稱——不然玩家完全感受不到這個機制存在
    // (灼燒不另外飄,它每次跳傷都已經是橘色數字了,再飄一次會洗版)。
    if (event.status && event.status !== 'burn') {
      const statusText = this.add
        .text(px, py - 10 * SCALE, STATUS_NAMES[event.status], {
          fontSize: `${11 * SCALE}px`,
          fontStyle: 'bold',
          color: STATUS_TEXT_COLORS[event.status],
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(3);
      this.tweens.add({
        targets: statusText,
        y: py - 32 * SCALE,
        alpha: 0,
        duration: 800,
        ease: 'Cubic.Out',
        onComplete: () => statusText.destroy(),
      });
    }
  }

  /**
   * 主動技能施放特效(見 sim/skills.ts):在施放中心畫一個擴張淡出的圓,顏色依技能區分。
   * 刻意不做成長駐圖層——技能是瞬間事件,特效放完就該消失,用 tween 自己銷毀最單純,
   * 跟飄動傷害數字走同一套模式(不需要 id-keyed 追蹤,也就不用管 resetCamera 的清理)。
   */
  private spawnSkillEffect(cast: SimulationState['skillCasts'][number]): void {
    const cx = cast.x * TILE_PX + TILE_PX / 2;
    const cy = cast.y * TILE_PX + TILE_PX / 2;
    const radius = (cast.rangeFp / FP_SCALE) * TILE_PX;
    const color = SKILL_EFFECT_COLORS[cast.skillId] ?? 0xffe98a;

    const ring = this.add.graphics().setDepth(2.5);
    ring.lineStyle(3 * SCALE, color, 0.9);
    ring.strokeCircle(cx, cy, radius);
    ring.fillStyle(color, 0.18);
    ring.fillCircle(cx, cy, radius);
    // 從施放中心「炸開」的感覺:從小圓放大到實際範圍再淡出。
    ring.setScale(0.35);
    // Graphics 的縮放是以 (0,0) 為原點,要先把原點移到圓心才不會一邊放大一邊往右下飄。
    ring.setPosition(cx - cx * 0.35, cy - cy * 0.35);
    this.tweens.add({
      targets: ring,
      scale: 1,
      x: 0,
      y: 0,
      alpha: 0,
      duration: 520,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
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
    // 多地圖:每場新對局的地圖可能不一樣,靜態層(地板/路徑/裝飾物)要照新地圖整個重畫。
    // main.ts 一定是在引擎建立完(createInitialState 已經呼叫過 setActiveMap)之後才呼叫
    // resetCamera(),所以這裡讀到的 isOnPath()/paths() 已經是新地圖的資料。
    this.rebuildStaticLayer();
    for (const sprite of this.towerSprites.values()) sprite.destroy();
    this.towerSprites.clear();
    for (const sprite of this.monsterSprites.values()) sprite.destroy();
    this.monsterSprites.clear();
    // 等級/名稱文字物件(Lv.N、怪物元素名稱)也要跟著清掉——新對局的 id 是從頭編號的,
    // 不清掉的話舊局殘留的文字可能被誤認成同 id 的新實體重複使用(內容沒換成新的)。
    for (const label of this.towerLevelTexts.values()) label.destroy();
    this.towerLevelTexts.clear();
    for (const label of this.trapLevelTexts.values()) label.destroy();
    this.trapLevelTexts.clear();
    for (const label of this.monsterNameTexts.values()) label.destroy();
    this.monsterNameTexts.clear();
    for (const label of this.totemLevelTexts.values()) label.destroy();
    this.totemLevelTexts.clear();
  }

  /** 把靜態層建立的物件記下來,重畫地圖時才清得掉(見 staticObjects / rebuildStaticLayer)。 */
  private trackStatic<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.staticObjects.push(obj);
    return obj;
  }

  /**
   * 換地圖後重畫整個靜態層。**必須在 map.ts 的 setActiveMap() 已經切好之後才呼叫**,
   * 否則畫出來的還是上一張地圖的路徑(isOnPath()/paths() 都是讀模組層級的活躍地圖)。
   * 由 resetCamera() 在每場新對局開始時呼叫。
   */
  private rebuildStaticLayer(): void {
    for (const obj of this.staticObjects) obj.destroy();
    this.staticObjects = [];
    this.drawStaticLayer();
    this.drawDecorations();
  }

  private drawStaticLayer(): void {
    const g = this.trackStatic(this.add.graphics());
    const mapWidthPx = GRID_WIDTH * TILE_PX;
    const mapHeightPx = GRID_HEIGHT * TILE_PX;

    // 這場對局用哪張地圖的材質(有專屬的用專屬,否則退回共用的,見 resolveTileKey)。
    const mapId = activeMapDefId();
    const floorKey = resolveTileKey(mapId, 'floor', this);
    const pathKey = resolveTileKey(mapId, 'path', this);

    // 有正式地板材質就整片鋪滿(材質已經做過 seamless tiling,TileSprite 重複貼不會有接縫);
    // 沒有就退回棋盤式雙色交錯畫法。地板先整片蓋住全部格子(含路徑格),路徑材質等等疊上去蓋掉。
    if (floorKey) {
      this.trackStatic(this.add.tileSprite(0, 0, mapWidthPx, mapHeightPx, floorKey).setOrigin(0, 0));
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
    if (pathKey) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
          if (!isOnPath(x, y)) continue;
          this.trackStatic(
            this.add
              .image(x * TILE_PX + TILE_PX / 2, y * TILE_PX + TILE_PX / 2, pathKey)
              .setDisplaySize(TILE_PX, TILE_PX),
          );
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
    // 疊色的顏色依地圖主題換:草原壓灰卡其(原本的值),雪原用冷灰藍才不會把雪壓成髒黃色,
    // 沙漠用暖褐。三張地圖的材質色調差很多,套同一個疊色會有一張看起來很不對。
    if (floorKey || pathKey) {
      const tint = TERRAIN_TINT_BY_MAP[mapId] ?? TERRAIN_TINT_DEFAULT;
      const terrainTint = this.trackStatic(this.add.graphics());
      terrainTint.fillStyle(tint.color, tint.alpha);
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
    for (const waypoints of paths()) {
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

  /**
   * 非路徑格灑一點樹/草叢/石頭/花/小動物,大片空地才不會太單調。畫一次不用每 tick 重畫。
   *
   * **AI 生的裝飾圖只在草原地圖用**:那批圖沒有去背,prompt 是「站在草地上」,所以每張都
   * 帶著一塊綠色草地方形背景——鋪在草原上看不太出來,但鋪在沙漠/雪原上會變成一格一格
   * 突兀的綠色補丁(實測截圖確認過)。非草原地圖改用程序生成的幾何造型(沒有背景方塊),
   * 並依地圖主題換掉造型組合跟配色,見 DECOR_THEME_BY_MAP。
   */
  private drawDecorations(): void {
    const g = this.trackStatic(this.add.graphics());
    const mapId = activeMapDefId();
    const theme = DECOR_THEME_BY_MAP[mapId] ?? DECOR_THEME_DEFAULT;

    // 每個主題自己的造型組合:草原有樹/草叢/花/小動物,沙漠只有石頭跟乾枯的灌木,
    // 雪原是石頭跟枯樹——用同一批 drawDecor*() 函式配不同顏色,不用另外畫新造型。
    const drawersByKind: Record<string, (cx: number, cy: number, seed: number) => void> = {
      tree: (cx, cy) => this.drawDecorTree(g, cx, cy, theme.foliage, theme.trunk),
      bush: (cx, cy) => this.drawDecorBush(g, cx, cy, theme.foliage),
      rock: (cx, cy) => this.drawDecorRock(g, cx, cy, theme.rock),
      flowers: (cx, cy) => this.drawDecorFlowers(g, cx, cy, theme.foliage),
      critter: (cx, cy, seed) => this.drawDecorCritter(g, cx, cy, seed),
    };
    const proceduralDrawers = theme.kinds.map((k) => drawersByKind[k]);

    for (let x = 0; x < GRID_WIDTH; x++) {
      for (let y = 0; y < GRID_HEIGHT; y++) {
        if (isOnPath(x, y)) continue;
        const h = tileHash(x, y);
        if (h % 100 >= DECOR_DENSITY_PERCENT) continue;
        const cx = x * TILE_PX + TILE_PX / 2;
        const cy = y * TILE_PX + TILE_PX / 2;
        const imageKey = DECOR_IMAGE_KEYS[Math.floor(h / 100) % DECOR_IMAGE_KEYS.length];
        if (theme.useAiImages && this.textures.exists(imageKey)) {
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
    const image = this.trackStatic(this.add.image(cx, cy, key).setDisplaySize(size, size));
    // 遮罩用的 Graphics 沒有加進 display list(this.make 不是 this.add),但換地圖重畫時
    // 一樣要跟著銷毀,不然會累積成看不見的記憶體洩漏——所以也一併追蹤。
    const maskShape = this.trackStatic(this.make.graphics({}).fillStyle(0xffffff, 1).fillCircle(cx, cy, size / 2));
    image.setMask(maskShape.createGeometryMask());
  }

  // 這幾個 drawDecor*() 都吃可選的顏色參數(見 DecorTheme):沙漠/雪原用同一批造型
  // 換配色就好,不用另外畫新造型。不傳就用原本草原的配色。
  private drawDecorTree(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    foliage = 0x2e6b3e,
    trunk = 0x5b3a22,
  ): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 6 * DECOR_SCALE, 14 * DECOR_SCALE, 4 * DECOR_SCALE);
    g.fillStyle(trunk, 1);
    g.fillRect(cx - 2 * DECOR_SCALE, cy, 4 * DECOR_SCALE, 7 * DECOR_SCALE);
    g.fillStyle(foliage, 1);
    g.fillCircle(cx, cy - 4 * DECOR_SCALE, 7 * DECOR_SCALE);
    g.fillStyle(lighten(foliage, 0.18), 1);
    g.fillCircle(cx - 2 * DECOR_SCALE, cy - 6 * DECOR_SCALE, 4 * DECOR_SCALE);
  }

  private drawDecorBush(g: Phaser.GameObjects.Graphics, cx: number, cy: number, foliage = 0x336b3a): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * DECOR_SCALE, 14 * DECOR_SCALE, 4 * DECOR_SCALE);
    g.fillStyle(foliage, 1);
    g.fillCircle(cx - 4 * DECOR_SCALE, cy, 5 * DECOR_SCALE);
    g.fillCircle(cx + 4 * DECOR_SCALE, cy, 5 * DECOR_SCALE);
    g.fillCircle(cx, cy - 3 * DECOR_SCALE, 5.5 * DECOR_SCALE);
  }

  private drawDecorRock(g: Phaser.GameObjects.Graphics, cx: number, cy: number, rockColor = 0x6b6b6b): void {
    g.fillStyle(0x000000, 0.15);
    g.fillEllipse(cx, cy + 4 * DECOR_SCALE, 12 * DECOR_SCALE, 3 * DECOR_SCALE);
    g.fillStyle(rockColor, 1);
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
    // 石頭上的一小塊苔蘚——用比石頭亮一點的同色系,沙漠/雪原就不會出現突兀的綠色苔蘚
    g.fillStyle(lighten(rockColor, 0.22), 0.5);
    g.fillCircle(cx - 2 * DECOR_SCALE, cy - 3 * DECOR_SCALE, 2 * DECOR_SCALE);
  }

  private drawDecorFlowers(g: Phaser.GameObjects.Graphics, cx: number, cy: number, foliage = 0x3a7d3a): void {
    g.fillStyle(0x000000, 0.12);
    g.fillEllipse(cx, cy + 3 * DECOR_SCALE, 10 * DECOR_SCALE, 3 * DECOR_SCALE);
    g.fillStyle(foliage, 1);
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

    // 符文圖騰的範圍圈固定顯示,不用選取就看得到覆蓋範圍——這是純支援建築,玩家要能一眼
    // 判斷「蓋在這裡罩得到哪些塔」,不像塔的射程圈只在選取時才顯示(那是攻擊判定的細節,
    // 圖騰範圍是擺放策略的核心資訊,顯示邏輯故意不一樣)。
    if (state.runeTotems.length > 0) {
      const rangePx = (RUNE_TOTEM_RANGE_FP / FP_SCALE) * TILE_PX;
      g.lineStyle(1.5 * SCALE, 0x9b59d0, 0.35);
      for (const totem of state.runeTotems) {
        const cx = totem.x * TILE_PX + TILE_PX / 2;
        const cy = totem.y * TILE_PX + TILE_PX / 2;
        g.strokeCircle(cx, cy, rangePx);
      }
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
    const waypoints = paths()[pathId];
    if (!waypoints) return tiles; // 換地圖後路徑數可能變少,防禦性處理
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
    const liveTrapIds = new Set<number>();
    for (const trap of state.traps) {
      liveTrapIds.add(trap.id);
      this.drawTrap(g, trap.id, trap.x, trap.y, trap.level, multiplayer ? ownerColorHex(state, trap.ownerId) : null);
    }
    this.pruneStaleSprites(this.trapLevelTexts, liveTrapIds);
    for (const building of state.resourceBuildings) {
      this.drawResourceBuilding(g, building.x, building.y, multiplayer ? ownerColorHex(state, building.ownerId) : null);
    }
    const liveTotemIds = new Set<number>();
    for (const totem of state.runeTotems) {
      liveTotemIds.add(totem.id);
      this.drawRuneTotem(
        g,
        totem.id,
        totem.x,
        totem.y,
        totem.level,
        totem.upgradePath,
        multiplayer ? ownerColorHex(state, totem.ownerId) : null,
      );
    }
    this.pruneStaleSprites(this.totemLevelTexts, liveTotemIds);

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
    this.pruneStaleSprites(this.monsterNameTexts, liveMonsterIds);
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
      this.drawTower(g, t.id, t.x, t.y, t.element, t.level, ownerMark, t.secondElement);
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
    this.drawLevelLabel(this.towerLevelTexts, t.id, cx, cy, t.level);
    this.drawSecondElementBadge(g, cx, cy, t.secondElement);
  }

  /** 多人模式下在建築底部畫一圈識別色橢圓,一眼看出這是誰蓋的;單人模式/顏色為 null 時不畫。 */
  private drawOwnerMark(g: Phaser.GameObjects.Graphics, cx: number, cy: number, ownerMark: number | null): void {
    if (ownerMark === null) return;
    g.lineStyle(2.5 * SCALE, ownerMark, 0.95);
    g.strokeEllipse(cx, cy + 9 * SCALE, 22 * SCALE, 6 * SCALE);
  }

  /**
   * 雙屬性塔(towers.ts 的 Tower.secondElement)在塔身右上角畫一個第二屬性顏色的小圓點——
   * 不用另外做新美術,靠既有的 ELEMENT_COLORS 就能一眼看出這座塔同時吃兩種屬性判定,
   * 跟 drawOwnerMark() 一樣是每 tick 重畫的 Graphics,不需要額外的 id-keyed GameObject 追蹤。
   */
  private drawSecondElementBadge(g: Phaser.GameObjects.Graphics, cx: number, cy: number, secondElement?: Element): void {
    if (!secondElement) return;
    const bx = cx + TILE_PX / 2 - 6 * SCALE;
    const by = cy - TILE_PX / 2 + 6 * SCALE;
    g.fillStyle(ELEMENT_COLORS[secondElement], 1);
    g.fillCircle(bx, by, 5 * SCALE);
    g.lineStyle(1.5 * SCALE, 0xffffff, 0.9);
    g.strokeCircle(bx, by, 5 * SCALE);
  }

  /**
   * 正上方的「Lv.N」文字,塔/陷阱共用同一套畫法,取代原本塔身上純點狀的等級指示——文字比
   * 數點數直接好讀,尤其升到高等級之後一排點也不好一眼數清楚。文字沒辦法用 Graphics 畫
   * (Graphics 只能畫幾何圖形),所以用 Phaser.GameObjects.Text,依 id 建立/更新/銷毀,
   * 跟 towerSprites 走同一套模式。store 由呼叫端傳入(塔跟陷阱的 id 是各自獨立的計數器,
   * 不能共用同一個 Map,否則會撞號)。
   */
  private drawLevelLabel(store: Map<number, Phaser.GameObjects.Text>, id: number, cx: number, cy: number, level: number): void {
    const y = cy - TILE_PX / 2 - 4 * SCALE;
    let label = store.get(id);
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
      store.set(id, label);
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
    const bossMul = m.isBoss ? 1.8 : 1;
    const key = monsterTextureKey(m.element);
    if (!this.textures.exists(key)) {
      this.monsterSprites.get(m.id)?.destroy();
      this.monsterSprites.delete(m.id);
      this.drawMonster(g, px, py, m.element, hpRatio, m.isBoss);
      this.drawMonsterStatusOverlay(g, m, px, py, bossMul);
      this.drawMonsterNameLabel(m.id, px, py, m.element, bossMul);
      return;
    }
    let sprite = this.monsterSprites.get(m.id);
    if (!sprite) {
      sprite = this.add.image(px, py, key).setDepth(1);
      this.monsterSprites.set(m.id, sprite);
    }
    sprite
      .setTexture(key)
      .setPosition(px, py)
      .setDisplaySize(TILE_PX * MONSTER_IMAGE_DISPLAY_RATIO * bossMul, TILE_PX * MONSTER_IMAGE_DISPLAY_RATIO * bossMul)
      // 異常狀態直接把整隻怪染色,一眼就看得出「這隻中了什麼」——比在旁邊擺小圖示更好認,
      // 而且不用多產一批狀態圖示美術。沒有狀態時要記得清回白色(不然會一直留著上一次的顏色)。
      .setTint(statusTintColor(m) ?? 0xffffff);
    this.drawMonsterOverlay(g, px, py, hpRatio, m.isBoss, bossMul);
    this.drawMonsterStatusOverlay(g, m, px, py, bossMul);
    this.drawMonsterNameLabel(m.id, px, py, m.element, bossMul);
  }

  /**
   * 怪物身上的「狀態/能力」疊加資訊,圖片版跟幾何圖形備援版共用:
   * - 護盾兵:血條上方再加一條藍色護盾條(獨立於血條,護盾扣完才輪到血量)
   * - 有特殊能力的怪:身體外圍一圈能力代表色的環,不用點進 tooltip 也分得出哪隻要優先處理
   * - 纏繞中:腳下畫一圈綠色藤蔓感的圓,強調牠「被定住不動」而不是走得慢
   */
  private drawMonsterStatusOverlay(
    g: Phaser.GameObjects.Graphics,
    m: Monster,
    px: number,
    py: number,
    bossMul: number,
  ): void {
    if (m.maxShieldHp > 0 && m.shieldHp > 0) {
      const ratio = Math.max(0, Math.min(1, m.shieldHp / m.maxShieldHp));
      const barW = 16 * SCALE * bossMul;
      const barH = 2 * SCALE;
      const barY = py - 15.5 * SCALE * bossMul; // 疊在血條正上方
      g.fillStyle(0x000000, 0.6);
      g.fillRect(px - barW / 2, barY, barW, barH);
      g.fillStyle(0x6ec6ff, 1);
      g.fillRect(px - barW / 2, barY, barW * ratio, barH);
    }

    const abilityColor = ABILITY_RING_COLORS[m.ability];
    if (abilityColor !== undefined) {
      g.lineStyle(1.5 * SCALE, abilityColor, 0.85);
      g.strokeCircle(px, py, 10 * SCALE * bossMul);
      // 光一圈顏色環只分得出「這隻特別」,分不出「特別在哪」——再畫一個代表能力的小符號。
      this.drawAbilityGlyph(g, m.ability, abilityColor, px, py, bossMul);
    }

    if (m.statusEntangleTicks > 0) {
      g.lineStyle(2 * SCALE, 0x3a9d3a, 0.9);
      g.strokeCircle(px, py + 6 * SCALE * bossMul, 7 * SCALE * bossMul);
    }
  }

  /**
   * 怪物能力的識別符號,畫在身體右上角(避開頭上的元素名稱文字跟上方的血條)。
   *
   * **刻意用 Graphics 畫幾何符號,不另外產美術**:5 種能力 × 5 種元素 = 25 張圖,
   * 產圖成本跟維護成本都不划算,而且能力是「疊加在既有怪物上的標記」,本來就不該
   * 換掉整隻怪的造型。幾何符號縮到這個尺寸(約 5px)反而比縮小的插圖好認。
   * 每種符號的造型對齊 index.html 裡對應的 SVG 圖示,玩家在 tooltip 跟地圖上看到的是同一個形狀。
   */
  private drawAbilityGlyph(
    g: Phaser.GameObjects.Graphics,
    ability: Monster['ability'],
    color: number,
    px: number,
    py: number,
    bossMul: number,
  ): void {
    const s = 2.6 * SCALE * bossMul; // 符號的半尺寸
    const cx = px + 8 * SCALE * bossMul;
    const cy = py - 7 * SCALE * bossMul;

    // 深色底盤,讓符號在任何顏色的怪身上都看得清楚
    g.fillStyle(0x000000, 0.55);
    g.fillCircle(cx, cy, s * 1.7);
    g.lineStyle(1 * SCALE, color, 1);
    g.fillStyle(color, 1);

    if (ability === 'healer') {
      // 十字
      g.fillRect(cx - s * 0.35, cy - s, s * 0.7, s * 2);
      g.fillRect(cx - s, cy - s * 0.35, s * 2, s * 0.7);
    } else if (ability === 'shield') {
      // 盾牌:上緣平、下緣收尖
      g.beginPath();
      g.moveTo(cx - s, cy - s * 0.9);
      g.lineTo(cx + s, cy - s * 0.9);
      g.lineTo(cx + s * 0.75, cy + s * 0.5);
      g.lineTo(cx, cy + s * 1.2);
      g.lineTo(cx - s * 0.75, cy + s * 0.5);
      g.closePath();
      g.fillPath();
    } else if (ability === 'splitter') {
      // 一個分成兩個
      g.fillCircle(cx, cy - s * 0.7, s * 0.55);
      g.fillCircle(cx - s * 0.75, cy + s * 0.75, s * 0.5);
      g.fillCircle(cx + s * 0.75, cy + s * 0.75, s * 0.5);
    } else if (ability === 'aura') {
      // speed lines
      g.fillRect(cx - s, cy - s * 0.75, s * 1.6, s * 0.4);
      g.fillRect(cx - s, cy - s * 0.1, s * 2, s * 0.4);
      g.fillRect(cx - s, cy + s * 0.55, s * 1.6, s * 0.4);
    } else {
      // bomber:圓身 + 引信
      g.fillCircle(cx, cy + s * 0.25, s * 0.9);
      g.lineStyle(1.2 * SCALE, color, 1);
      g.lineBetween(cx + s * 0.5, cy - s * 0.4, cx + s * 1.1, cy - s * 1.1);
    }
  }

  /** 怪物頭上顯示元素名稱(金/木/水/火/土),圖片版跟幾何圖形版共用同一個畫法。 */
  private drawMonsterNameLabel(id: number, px: number, py: number, element: Element, bossMul: number): void {
    const y = py - 16 * SCALE * bossMul;
    let label = this.monsterNameTexts.get(id);
    if (!label) {
      label = this.add
        .text(px, y, '', {
          fontSize: `${9 * SCALE}px`,
          fontFamily: '"Microsoft JhengHei", sans-serif',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 2 * SCALE,
        })
        .setOrigin(0.5, 1)
        .setDepth(2);
      this.monsterNameTexts.set(id, label);
    }
    label.setPosition(px, y).setText(ELEMENT_NAMES[element]);
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

  /** 陷阱目前沒有正式美術,先畫一排小尖刺(壓力板/地刺的感覺),蓋在路徑格材質上面。等級可升級(見 placements.ts),正上方顯示「Lv.N」。 */
  private drawTrap(g: Phaser.GameObjects.Graphics, id: number, gridX: number, gridY: number, level: number, ownerMark: number | null): void {
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
    this.drawLevelLabel(this.trapLevelTexts, id, cx, cy, level);
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

  /**
   * 符文圖騰目前沒有正式美術,畫一個發光水晶方尖碑造型——刻意跟塔/怪物(五行配色)、
   * 資源建築(金色屋頂)都不同色,一眼就看得出「這是純支援建築,不是攻擊單位」。分歧路線
   * 定案後(2 級)換不同色系:強化(damage)偏紅紫、疾風(haste)偏藍紫,還沒分歧(1 級)
   * 維持原本的紫色,一眼就能區分三種狀態不用點進去看數字。
   * 範圍圈另外畫在 groundEffectsLayer(見 drawGroundEffects()),不用選取就能看到覆蓋範圍。
   */
  private drawRuneTotem(
    g: Phaser.GameObjects.Graphics,
    id: number,
    gridX: number,
    gridY: number,
    level: number,
    upgradePath: 'none' | 'damage' | 'haste',
    ownerMark: number | null,
  ): void {
    const cx = gridX * TILE_PX + TILE_PX / 2;
    const cy = gridY * TILE_PX + TILE_PX / 2;
    const specialized = level >= 2 && upgradePath !== 'none';
    const color = specialized ? (upgradePath === 'haste' ? 0x4a8fe0 : 0xe0398f) : 0x9b59d0;
    g.fillStyle(color, 0.15);
    g.fillCircle(cx, cy, 17 * SCALE);
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(cx, cy + 9 * SCALE, 20 * SCALE, 6 * SCALE);
    g.fillStyle(color, 1);
    g.fillTriangle(cx - 7 * SCALE, cy + 7 * SCALE, cx, cy - 13 * SCALE, cx + 7 * SCALE, cy + 7 * SCALE);
    g.lineStyle(1 * SCALE, 0x2d1b3a, 0.5);
    g.strokeTriangle(cx - 7 * SCALE, cy + 7 * SCALE, cx, cy - 13 * SCALE, cx + 7 * SCALE, cy + 7 * SCALE);
    g.fillStyle(0xffffff, 0.7);
    g.fillCircle(cx, cy - 2 * SCALE, 2 * SCALE);
    this.drawOwnerMark(g, cx, cy, ownerMark);
    this.drawLevelLabel(this.totemLevelTexts, id, cx, cy, level);
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
    secondElement?: Element,
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
    this.drawLevelLabel(this.towerLevelTexts, id, cx, cy, level);
    this.drawSecondElementBadge(g, cx, cy, secondElement);
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
