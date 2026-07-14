// 固定路徑地圖。刻意不做動態尋路——路徑是寫死的 waypoints,蓋塔只能蓋在非路徑格,
// 這樣完全不需要 A* 之類的尋路演算法,少一個決定性風險來源。
// 所有座標/距離都用定點數整數(FP_SCALE = 1 格),不用 float。

export const FP_SCALE = 1000;
export const GRID_WIDTH = 16;
export const GRID_HEIGHT = 10;

/** 路徑轉折點,格子座標。相鄰兩點必須是水平或垂直對齊(不能斜線)。 */
export const PATH_WAYPOINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 5],
  [4, 5],
  [4, 2],
  [9, 2],
  [9, 7],
  [13, 7],
  [13, 4],
  [15, 4],
];

function computeSegmentLengthsFp(): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < PATH_WAYPOINTS.length - 1; i++) {
    const [ax, ay] = PATH_WAYPOINTS[i];
    const [bx, by] = PATH_WAYPOINTS[i + 1];
    const tiles = Math.abs(bx - ax) + Math.abs(by - ay);
    lengths.push(tiles * FP_SCALE);
  }
  return lengths;
}

export const SEGMENT_LENGTHS_FP = computeSegmentLengthsFp();

function computePathTiles(): Set<string> {
  const tiles = new Set<string>();
  for (let i = 0; i < PATH_WAYPOINTS.length - 1; i++) {
    const [ax, ay] = PATH_WAYPOINTS[i];
    const [bx, by] = PATH_WAYPOINTS[i + 1];
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (let s = 0; s <= steps; s++) {
      tiles.add(`${ax + dx * s},${ay + dy * s}`);
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
  /** 0..SEGMENT_LENGTHS_FP.length-1;等於 length 代表已經走到終點(漏怪) */
  segmentIndex: number;
  distanceIntoSegmentFp: number;
}

export function createStartPos(): PathPos {
  return { segmentIndex: 0, distanceIntoSegmentFp: 0 };
}

/** 沿路徑前進 speedFp 定點數單位。回傳新位置,以及是否已經走到終點(漏怪)。 */
export function advanceAlongPath(pos: PathPos, speedFp: number): { pos: PathPos; leaked: boolean } {
  let segmentIndex = pos.segmentIndex;
  let distanceIntoSegmentFp = pos.distanceIntoSegmentFp;
  let remaining = speedFp;

  while (remaining > 0 && segmentIndex < SEGMENT_LENGTHS_FP.length) {
    const segLen = SEGMENT_LENGTHS_FP[segmentIndex];
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

  const leaked = segmentIndex >= SEGMENT_LENGTHS_FP.length;
  return { pos: { segmentIndex, distanceIntoSegmentFp }, leaked };
}

/** 怪物在畫面上的定點數世界座標(x/y 都乘了 FP_SCALE),純整數運算。 */
export function worldPositionFp(pos: PathPos): { xFp: number; yFp: number } {
  if (pos.segmentIndex >= PATH_WAYPOINTS.length - 1) {
    const [lx, ly] = PATH_WAYPOINTS[PATH_WAYPOINTS.length - 1];
    return { xFp: lx * FP_SCALE, yFp: ly * FP_SCALE };
  }
  const [ax, ay] = PATH_WAYPOINTS[pos.segmentIndex];
  const [bx, by] = PATH_WAYPOINTS[pos.segmentIndex + 1];
  const dx = Math.sign(bx - ax);
  const dy = Math.sign(by - ay);
  return {
    xFp: ax * FP_SCALE + dx * pos.distanceIntoSegmentFp,
    yFp: ay * FP_SCALE + dy * pos.distanceIntoSegmentFp,
  };
}
