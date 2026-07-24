// 地圖:支援多張地圖 x 多條固定路徑(寫死 waypoints,不做動態尋路/A*),路徑之間可以交叉,
// 蓋塔只能蓋在非路徑格。所有座標/距離都用定點數整數(FP_SCALE = 1 格),不用 float。

export const FP_SCALE = 1000;
export const GRID_WIDTH = 40;
export const GRID_HEIGHT = 24;

/** 畫面上一次看得到的格數(相機視窗大小);現在畫面會縮放到整張地圖塞得下,這兩個值已經沒有實際作用。 */
export const VIEWPORT_TILES_W = 22;
export const VIEWPORT_TILES_H = 14;

/**
 * 地圖定義。每張地圖是一組路徑,每條路徑是一串轉折點(格子座標),相鄰兩點必須水平或垂直
 * 對齊(不能斜線)。所有地圖共用同一個 GRID_WIDTH x GRID_HEIGHT 尺寸——畫面縮放、小地圖、
 * 裝飾物雜湊都是照這個尺寸算的,不同尺寸的地圖要動的地方太多,先統一。
 *
 * **路徑數量可以不一樣**(個人生命模式的生命池子是照當前地圖的路徑數平分,見
 * simulation.ts 的 createInitialState),所以 PATH_COUNT 不再是編譯期常數,改用 pathCount()。
 */
export interface MapDef {
  id: string;
  name: string;
  /** 選單上給玩家看的一句話說明,講清楚這張地圖難在哪。 */
  description: string;
  paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

export const MAP_DEFS: readonly MapDef[] = [
  {
    id: 'crossroads',
    name: '雙線交會',
    description: '兩條路線在中央交叉一次,交叉點附近的塔可以同時顧到兩邊。',
    paths: [
      [
        [0, 12],
        [9, 12],
        [9, 5],
        [20, 5],
        [20, 18],
        [29, 18],
        [29, 9],
        [39, 9],
      ],
      [
        [23, 0],
        [23, 14],
        [34, 14],
        [34, 23],
      ],
    ],
  },
  {
    id: 'serpent',
    name: '長蛇迴廊',
    description: '單一條路但來回折返很長,塔的射程覆蓋率是關鍵,適合練習擺位。',
    paths: [
      [
        [0, 2],
        [36, 2],
        [36, 7],
        [3, 7],
        [3, 12],
        [36, 12],
        [36, 17],
        [3, 17],
        [3, 21],
        [39, 21],
      ],
    ],
  },
  {
    id: 'trident',
    // 說明修正(2026-07-24):原本寫「各走各的互不交會」,但實際上路徑 0-2 在 (27,8)、
    // 路徑 1-2 在 (33,21) 有交叉——排查個人生命模式的跨路徑火力時算出來的,說明要誠實。
    name: '三叉分流',
    description: '三條路線大致分流,少數交會點可以蓋協防塔,火力必須分散,考驗資源分配。',
    paths: [
      [
        [0, 3],
        [14, 3],
        [14, 11],
        [27, 11],
        [27, 4],
        [39, 4],
      ],
      [
        [0, 20],
        [10, 20],
        [10, 15],
        [24, 15],
        [24, 21],
        [39, 21],
      ],
      [
        [19, 0],
        [19, 8],
        [33, 8],
        [33, 23],
      ],
    ],
  },
  {
    // 四線地圖(2026-07-24 加的,玩家點名要的):四條水平路線分區推進、左右交錯進攻
    // (奇數線由右往左),為個人生命模式的「各守各的路」設計——4 人以上剛好一人一線。
    // 線與線的垂直間距刻意拉開(基準列 2/8/14/20,S 彎只往線內側偏 2 格),讓大多數位置
    // 的塔只搆得到自己那條線;相鄰線的 S 彎交錯處留了少數垂直距離 4 格的窄窗,蓋在正中間
    // 的長射程塔(木塔 2.8 格)可以勉強雙打,是刻意的「協防點」,不是設計失誤。
    id: 'quad',
    name: '四線防區',
    description: '四條路線分區推進、左右交錯進攻,適合 4 人以上一人守一線;線間留少數協防點。',
    paths: [
      [
        [0, 2],
        [16, 2],
        [16, 4],
        [32, 4],
        [32, 2],
        [39, 2],
      ],
      [
        [39, 8],
        [28, 8],
        [28, 10],
        [12, 10],
        [12, 8],
        [0, 8],
      ],
      [
        [0, 14],
        [10, 14],
        [10, 16],
        [26, 16],
        [26, 14],
        [39, 14],
      ],
      [
        [39, 20],
        [30, 20],
        [30, 22],
        [14, 22],
        [14, 20],
        [0, 20],
      ],
    ],
  },
];

export const DEFAULT_MAP_ID = MAP_DEFS[0].id;

export function mapDefById(mapId: string): MapDef {
  return MAP_DEFS.find((m) => m.id === mapId) ?? MAP_DEFS[0];
}

export function isMapId(v: unknown): v is string {
  return typeof v === 'string' && MAP_DEFS.some((m) => m.id === v);
}

// ---- 目前這場對局用的地圖 ----
//
// 地圖在一場對局裡從頭到尾固定不變(開局前選好,`SimulationState.mapId` 記著),所以用一個
// 模組層級的「目前地圖」快取,避免每個 map 函式都要多帶一個 mapId 參數(那會波及 towers.ts /
// simulation.ts / GameScene.ts 幾十個呼叫點)。
//
// **決定性**:所有機器在 createInitialState() 都會用同一個 mapId 呼叫 setActiveMap(),之後
// 整場不再變動,所以每台機器算出來的路徑資料完全一致——step() 仍然是「同樣輸入算出同樣輸出」。
// ⚠️ 換房主的 RESYNC 走的是「整份取代 state」而不是 createInitialState(),所以
// lockstep.ts 套用 RESYNC 時要記得依 state.mapId 補呼叫一次 setActiveMap()。
let activePaths: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = MAP_DEFS[0].paths;
let activeSegmentLengthsFp: readonly number[][] = [];
let activePathTiles: Set<string> = new Set();
let activeMapId: string = DEFAULT_MAP_ID;

function computeSegmentLengthsFp(waypoints: ReadonlyArray<readonly [number, number]>): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [ax, ay] = waypoints[i];
    const [bx, by] = waypoints[i + 1];
    const tiles = Math.abs(bx - ax) + Math.abs(by - ay);
    lengths.push(tiles * FP_SCALE);
  }
  return lengths;
}

function computePathTiles(paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): Set<string> {
  const tiles = new Set<string>();
  for (const waypoints of paths) {
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [ax, ay] = waypoints[i];
      const [bx, by] = waypoints[i + 1];
      const dx = Math.sign(bx - ax);
      const dy = Math.sign(by - ay);
      const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let s = 0; s <= steps; s++) {
        tiles.add(`${ax + dx * s},${ay + dy * s}`);
      }
    }
  }
  return tiles;
}

/** 切換這場對局要用的地圖。createInitialState() 跟 RESYNC 套用時都要呼叫,對局中不會再變動。 */
export function setActiveMap(mapId: string): void {
  const def = mapDefById(mapId);
  activeMapId = def.id;
  activePaths = def.paths;
  activeSegmentLengthsFp = def.paths.map(computeSegmentLengthsFp);
  activePathTiles = computePathTiles(def.paths);
}

setActiveMap(DEFAULT_MAP_ID);

export function activeMapDefId(): string {
  return activeMapId;
}

/** 目前地圖的路徑清單(GameScene 畫路徑/小地圖要用)。 */
export function paths(): ReadonlyArray<ReadonlyArray<readonly [number, number]>> {
  return activePaths;
}

/** 目前地圖有幾條路徑。以前是編譯期常數 PATH_COUNT,多地圖之後每張地圖可能不一樣。 */
export function pathCount(): number {
  return activePaths.length;
}

export function isOnPath(x: number, y: number): boolean {
  return activePathTiles.has(`${x},${y}`);
}

/**
 * 列出某條路徑經過的所有格子座標(跟 computePathTiles 同一套走法,只是單一路徑分開算)。
 * UI 端用:GameScene 的水路視覺效果、main.ts 算「這一格蓋塔搆得到哪些路徑」
 * (個人生命模式的蓋塔提示)。回傳每次都重算,呼叫端不要在熱路徑裡每影格呼叫。
 */
export function tilesOfPath(pathId: number): Array<[number, number]> {
  const tiles: Array<[number, number]> = [];
  const waypoints = activePaths[pathId];
  if (!waypoints) return tiles;
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

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT;
}

export interface PathPos {
  pathId: number;
  /** 0..該路徑 segment 數-1;等於 segment 數代表已經走到終點(漏怪) */
  segmentIndex: number;
  distanceIntoSegmentFp: number;
}

export function createStartPos(pathId: number): PathPos {
  return { pathId, segmentIndex: 0, distanceIntoSegmentFp: 0 };
}

/** 沿路徑前進 speedFp 定點數單位。回傳新位置,以及是否已經走到終點(漏怪)。 */
export function advanceAlongPath(pos: PathPos, speedFp: number): { pos: PathPos; leaked: boolean } {
  const lengths = activeSegmentLengthsFp[pos.pathId] ?? [];
  let segmentIndex = pos.segmentIndex;
  let distanceIntoSegmentFp = pos.distanceIntoSegmentFp;
  let remaining = speedFp;

  while (remaining > 0 && segmentIndex < lengths.length) {
    const segLen = lengths[segmentIndex];
    const spaceLeft = segLen - distanceIntoSegmentFp;
    if (remaining < spaceLeft) {
      distanceIntoSegmentFp += remaining;
      remaining = 0;
    } else {
      remaining -= spaceLeft;
      segmentIndex += 1;
      distanceIntoSegmentFp = 0;
    }
  }

  const leaked = segmentIndex >= lengths.length;
  return { pos: { pathId: pos.pathId, segmentIndex, distanceIntoSegmentFp }, leaked };
}

/**
 * 沿路徑「往回退」distFp 定點數單位(土屬性塔的擊退效果用,見 towers.ts 的 STATUS_BY_ELEMENT)。
 * 退到起點就停住不會變成負的,也不會退到別條路徑上。跟 advanceAlongPath 一樣全程整數運算。
 */
export function retreatAlongPath(pos: PathPos, distFp: number): PathPos {
  const lengths = activeSegmentLengthsFp[pos.pathId] ?? [];
  // 已經走到終點的位置(segmentIndex 等於 segment 數)先夾回最後一段的尾端再往回退。
  let segmentIndex = Math.min(pos.segmentIndex, Math.max(0, lengths.length - 1));
  let distanceIntoSegmentFp =
    pos.segmentIndex >= lengths.length ? (lengths[segmentIndex] ?? 0) : pos.distanceIntoSegmentFp;
  let remaining = distFp;

  while (remaining > 0) {
    if (remaining <= distanceIntoSegmentFp) {
      distanceIntoSegmentFp -= remaining;
      remaining = 0;
    } else if (segmentIndex === 0) {
      distanceIntoSegmentFp = 0; // 退到整條路的起點就停住
      remaining = 0;
    } else {
      remaining -= distanceIntoSegmentFp;
      segmentIndex -= 1;
      distanceIntoSegmentFp = lengths[segmentIndex];
    }
  }

  return { pathId: pos.pathId, segmentIndex, distanceIntoSegmentFp };
}

/** 怪物在畫面上的定點數世界座標(x/y 都乘了 FP_SCALE),純整數運算。 */
export function worldPositionFp(pos: PathPos): { xFp: number; yFp: number } {
  const waypoints = activePaths[pos.pathId] ?? activePaths[0];
  if (pos.segmentIndex >= waypoints.length - 1) {
    const [lx, ly] = waypoints[waypoints.length - 1];
    return { xFp: lx * FP_SCALE, yFp: ly * FP_SCALE };
  }
  const [ax, ay] = waypoints[pos.segmentIndex];
  const [bx, by] = waypoints[pos.segmentIndex + 1];
  const dx = Math.sign(bx - ax);
  const dy = Math.sign(by - ay);
  return {
    xFp: ax * FP_SCALE + dx * pos.distanceIntoSegmentFp,
    yFp: ay * FP_SCALE + dy * pos.distanceIntoSegmentFp,
  };
}

/**
 * 從目前位置走到該路徑終點還剩多少定點數距離。
 * 不同路徑長度不一樣,segmentIndex 沒辦法直接跨路徑比較「誰比較接近終點」,
 * 這個剩餘距離是統一的絕對單位,才能拿來跨路徑比大小(塔的選目標邏輯要用)。
 */
export function remainingDistanceFp(pos: PathPos): number {
  const lengths = activeSegmentLengthsFp[pos.pathId] ?? [];
  let remaining = 0;
  for (let i = pos.segmentIndex; i < lengths.length; i++) {
    remaining += i === pos.segmentIndex ? lengths[i] - pos.distanceIntoSegmentFp : lengths[i];
  }
  return remaining;
}
