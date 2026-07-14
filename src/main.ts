// Phase 1+3 手動測試頁面。不是正式遊戲 UI(還沒接 Phaser),純粹用來驗證
// 建房/加入/tick 同步,以及 Phase 1 的塔防模擬邏輯本身有沒有正確運作。

import type { IceConfig } from './net/net';
import { HostLockstepEngine, ClientLockstepEngine, type LockstepHandlers } from './net/lockstep';
import { Room, type MatchConfig, type RoomHandlers } from './net/room';
import type { PlayerInfo } from './net/protocol';
import { ELEMENT_NAMES, type Element } from './sim/elements';
import { FP_SCALE, GRID_HEIGHT, GRID_WIDTH, PATH_WAYPOINTS, worldPositionFp } from './sim/map';
import type { SimulationState } from './sim/simulation';

const DEFAULT_MATCH_CONFIG: MatchConfig = {
  tickRateMs: 50,
  inputDelayTicks: 6,
  countdownMs: 3000,
};

const TILE_PX = 32;

const ELEMENT_COLORS: Record<Element, string> = {
  metal: '#d4af37',
  wood: '#3a9d3a',
  water: '#3a7bd5',
  fire: '#e05a2b',
  earth: '#a67c3d',
};

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const turnUserInput = $<HTMLInputElement>('turnUser');
const turnCredInput = $<HTMLInputElement>('turnCred');
const hostNameInput = $<HTMLInputElement>('hostName');
const hostBtn = $<HTMLButtonElement>('hostBtn');
const roomCodeEl = $<HTMLSpanElement>('roomCode');
const joinNameInput = $<HTMLInputElement>('joinName');
const joinCodeInput = $<HTMLInputElement>('joinCode');
const joinBtn = $<HTMLButtonElement>('joinBtn');
const inviteLinkInput = $<HTMLInputElement>('inviteLink');
const copyLinkBtn = $<HTMLButtonElement>('copyLinkBtn');
const rosterEl = $<HTMLUListElement>('roster');
const startBtn = $<HTMLButtonElement>('startBtn');
const goldEl = $<HTMLSpanElement>('gold');
const livesEl = $<HTMLSpanElement>('lives');
const tickEl = $<HTMLSpanElement>('tick');
const checksumEl = $<HTMLSpanElement>('checksum');
const resultBannerEl = $<HTMLDivElement>('resultBanner');
const logEl = $<HTMLPreElement>('log');
const gameCanvas = $<HTMLCanvasElement>('gameCanvas');
const canvasCtx = gameCanvas.getContext('2d');
if (!canvasCtx) throw new Error('無法取得 2D canvas context');
const ctx = canvasCtx;

let room: Room | null = null;
let hostEngine: HostLockstepEngine | null = null;
let clientEngine: ClientLockstepEngine | null = null;
let matchActive = false;

function log(msg: string): void {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${msg}\n${logEl.textContent ?? ''}`;
}

function iceConfigFromForm(): IceConfig {
  return {
    turnUsername: turnUserInput.value || undefined,
    turnCredential: turnCredInput.value || undefined,
  };
}

function buildInviteLink(roomCode: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

// 網址帶 ?room=xxx 的話直接幫忙填進「加入房間」欄位——朋友點連結就不用手動輸入房號
const roomCodeFromUrl = new URLSearchParams(window.location.search).get('room');
if (roomCodeFromUrl) {
  joinCodeInput.value = roomCodeFromUrl;
}

function renderRoster(roster: PlayerInfo[]): void {
  rosterEl.innerHTML = roster
    .map((p) => `<li>slot ${p.slot}: ${p.name} (${p.playerId})</li>`)
    .join('');
}

function selectedElement(): Element {
  const checked = document.querySelector<HTMLInputElement>('input[name="element"]:checked');
  return (checked?.value as Element | undefined) ?? 'metal';
}

function renderGame(state: SimulationState): void {
  ctx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

  // 網格
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_WIDTH; x++) {
    ctx.beginPath();
    ctx.moveTo(x * TILE_PX, 0);
    ctx.lineTo(x * TILE_PX, GRID_HEIGHT * TILE_PX);
    ctx.stroke();
  }
  for (let y = 0; y <= GRID_HEIGHT; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * TILE_PX);
    ctx.lineTo(GRID_WIDTH * TILE_PX, y * TILE_PX);
    ctx.stroke();
  }

  // 路徑
  ctx.strokeStyle = '#555';
  ctx.lineWidth = TILE_PX * 0.6;
  ctx.beginPath();
  PATH_WAYPOINTS.forEach(([x, y], i) => {
    const px = x * TILE_PX + TILE_PX / 2;
    const py = y * TILE_PX + TILE_PX / 2;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // 塔
  for (const t of state.towers) {
    ctx.fillStyle = ELEMENT_COLORS[t.element];
    ctx.beginPath();
    ctx.arc(t.x * TILE_PX + TILE_PX / 2, t.y * TILE_PX + TILE_PX / 2, TILE_PX * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  // 怪物
  for (const m of state.monsters) {
    const { xFp, yFp } = worldPositionFp(m.pos);
    const px = (xFp / FP_SCALE) * TILE_PX;
    const py = (yFp / FP_SCALE) * TILE_PX;
    ctx.fillStyle = ELEMENT_COLORS[m.element];
    ctx.fillRect(px - 4, py - 4, 8, 8);
  }
}

const lockstepHandlers: LockstepHandlers = {
  onStateUpdated: (state) => {
    tickEl.textContent = String(state.tick);
    checksumEl.textContent = state.checksum;
    goldEl.textContent = String(state.gold);
    livesEl.textContent = String(state.lives);
    renderGame(state);
    if (state.gameOver) resultBannerEl.textContent = '守備失敗(生命歸零)';
    else if (state.victory) resultBannerEl.textContent = '守備成功!全部波次清空';
  },
  onWaitingForTick: () => {
    // MVP 測試頁先不特別顯示等待狀態,tick 數字停住不動就代表在等
  },
};

const roomHandlers: RoomHandlers = {
  onRosterChanged: (roster) => {
    renderRoster(roster);
    startBtn.disabled = room?.getRole() !== 'host';
  },
  onMatchStarted: (payload) => {
    log(`對局開始,seed=${payload.seed}`);
    matchActive = true;
    resultBannerEl.textContent = '';
    if (!room) return;
    if (room.getRole() === 'host') {
      hostEngine = new HostLockstepEngine(
        room,
        {
          tickRateMs: payload.tickRateMs,
          inputDelayTicks: payload.inputDelayTicks,
          countdownMs: payload.countdownMs,
        },
        payload.seed,
        lockstepHandlers,
      );
      hostEngine.start();
    } else {
      clientEngine = new ClientLockstepEngine(room, payload.seed, lockstepHandlers);
    }
  },
  onRejected: (reason) => log(`加入被拒絕:${reason}`),
  onRoomEnded: (reasonText) => {
    log(`房間結束:${reasonText}`);
    matchActive = false;
    hostEngine?.stop();
    hostEngine = null;
    clientEngine = null;
  },
  onCommand: (cmd) => hostEngine?.enqueueRemoteCommand(cmd),
  onTick: (tick) => clientEngine?.receiveTick(tick),
};

hostBtn.addEventListener('click', () => {
  hostBtn.disabled = true;
  void Room.host(hostNameInput.value || '房主', iceConfigFromForm(), roomHandlers)
    .then(({ room: r, roomCode }) => {
      room = r;
      roomCodeEl.textContent = roomCode;
      inviteLinkInput.value = buildInviteLink(roomCode);
      copyLinkBtn.disabled = false;
      log(`房間已建立:${roomCode}`);
    })
    .catch((err: unknown) => {
      log(`建立房間失敗:${String(err)}`);
      hostBtn.disabled = false;
    });
});

joinBtn.addEventListener('click', () => {
  joinBtn.disabled = true;
  const code = joinCodeInput.value.trim();
  void Room.join(code, joinNameInput.value || '玩家', iceConfigFromForm(), roomHandlers)
    .then((r) => {
      room = r;
      log(`已加入房間:${code}`);
    })
    .catch((err: unknown) => {
      log(`加入房間失敗:${String(err)}`);
      joinBtn.disabled = false;
    });
});

copyLinkBtn.addEventListener('click', () => {
  void navigator.clipboard.writeText(inviteLinkInput.value).then(
    () => log('邀請連結已複製'),
    () => {
      inviteLinkInput.select();
      log('自動複製失敗,已幫你選取文字,手動 Ctrl+C 複製');
    },
  );
});

startBtn.addEventListener('click', () => {
  room?.startMatch(DEFAULT_MATCH_CONFIG);
});

gameCanvas.addEventListener('click', (ev) => {
  if (!matchActive || !room) return;
  const rect = gameCanvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * GRID_WIDTH);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * GRID_HEIGHT);
  const action = { kind: 'build_tower', params: { x, y, element: selectedElement() } };
  if (room.getRole() === 'host') hostEngine?.submitLocalCommand(action);
  else clientEngine?.submitLocalCommand(action);
});

log(`元素對照:${Object.entries(ELEMENT_NAMES).map(([k, v]) => `${k}=${v}`).join(' ')}`);
