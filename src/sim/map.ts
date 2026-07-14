// 地圖:支援多條固定路徑(寫死 waypoints,不做動態尋路/A*),路徑之間可以交叉,
// 蓋塔只能蓋在非路徑格。所有座標/距離都用定點數整數(FP_SCALE = 1 格),不用 float。

export const FP_SCALE = 1000;
export const GRID_WIDTH = 22;
export const GRID_HEIGHT = 14;

/**
 * 多條路徑,每條是一串轉折點(格子座標)。相鄰兩點必須是水平或垂直對齊(不能斜線)。
 * 路徑 0 是主要路線;路徑 1 跟路徑 0 在 (16,8) 交叉一次,提升防守難度(不能只顧一條線)。
 * 22x14 格(比最初的 16x10 大不少)留給蓋塔的空間多很多——改格子數記得順手用腳本驗證
 * 交叉點數量/邊界有沒有跑掉(見 commit 紀錄裡的驗證腳本)。
 */
export const PATHS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0, 7],
    [5, 7],
    [5, 3],
    [11, 3],
    [11, 10],
    [16, 10],
    [16, 5],
    [21, 5],
  ],
  [
    [13, 0],
    [13, 8],
    [19, 8],
    [19, 13],
  ],
];

export const PATH_COUNT = PATHS.length;

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

export const SEGMENT_LENGTHS_FP_BY_PATH: readonly number[][] = PATHS.map(computeSegmentLengthsFp);

function computePathTiles(): Set<string> {
  const tiles = new Set<string>();
  for (const waypoints of PATHS) {
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

const PATH_TILES = computePathTiles();

export function isOnPath(x: number, y: number): boolean {
  return PATH_TILES.has(`${x},${y}`);
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
  const lengths = SEGMENT_LENGTHS_FP_BY_PATH[pos.pathId];
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

/** 怪物在畫面上的定點數世界座標(x/y 都乘了 FP_SCALE),純整數運算。 */
export function worldPositionFp(pos: PathPos): { xFp: number; yFp: number } {
  const waypoints = PATHS[pos.pathId];
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
  const lengths = SEGMENT_LENGTHS_FP_BY_PATH[pos.pathId];
  let remaining = 0;
  for (let i = pos.segmentIndex; i < lengths.length; i++) {
    remaining += i === pos.segmentIndex ? lengths[i] - pos.distanceIntoSegmentFp : lengths[i];
  }
  return remaining;
}
