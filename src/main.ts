// Phase 1+3 手動測試頁面。不是正式遊戲 UI(還沒接 Phaser),純粹用來驗證
// 建房/加入/tick 同步,以及 Phase 1 的塔防模擬邏輯本身有沒有正確運作。

import type { IceConfig } from './net/net';
import { HostLockstepEngine, ClientLockstepEngine, type LockstepHandlers } from './net/lockstep';
import { Room, type MatchConfig, type RoomHandlers } from './net/room';
import type { PlayerInfo } from './net/protocol';
import { createGameRenderer } from './game/PhaserGame';
import { ELEMENT_NAMES, type Element } from './sim/elements';
import { LocalEngine } from './sim/localEngine';

const DEFAULT_MATCH_CONFIG: MatchConfig = {
  tickRateMs: 50,
  inputDelayTicks: 6,
  countdownMs: 3000,
};

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const soloBtn = $<HTMLButtonElement>('soloBtn');
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

let room: Room | null = null;
let hostEngine: HostLockstepEngine | null = null;
let clientEngine: ClientLockstepEngine | null = null;
let localEngine: LocalEngine | null = null;
let matchActive = false;

const gameRenderer = createGameRenderer('gameCanvas', (x, y) => {
  if (!matchActive || (!room && !localEngine)) return;
  const action = { kind: 'build_tower', params: { x, y, element: selectedElement() } };
  if (localEngine) localEngine.submitCommand(action);
  else if (room?.getRole() === 'host') hostEngine?.submitLocalCommand(action);
  else clientEngine?.submitLocalCommand(action);
});

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

function endLocalMatch(): void {
  if (!localEngine) return;
  localEngine.stop();
  localEngine = null;
  soloBtn.disabled = false;
  hostBtn.disabled = false;
  joinBtn.disabled = false;
}

const lockstepHandlers: LockstepHandlers = {
  onStateUpdated: (state) => {
    tickEl.textContent = String(state.tick);
    checksumEl.textContent = state.checksum;
    goldEl.textContent = String(state.gold);
    livesEl.textContent = String(state.lives);
    gameRenderer.renderState(state);
    if (state.gameOver) {
      resultBannerEl.textContent = '守備失敗(生命歸零)';
      endLocalMatch();
    } else if (state.victory) {
      resultBannerEl.textContent = '守備成功!全部波次清空';
      endLocalMatch();
    }
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

soloBtn.addEventListener('click', () => {
  soloBtn.disabled = true;
  hostBtn.disabled = true;
  joinBtn.disabled = true;
  matchActive = true;
  resultBannerEl.textContent = '';
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  localEngine = new LocalEngine(seed, DEFAULT_MATCH_CONFIG.tickRateMs, lockstepHandlers);
  localEngine.start();
  log(`單人模式開始,seed=${seed}`);
});

hostBtn.addEventListener('click', () => {
  hostBtn.disabled = true;
  soloBtn.disabled = true;
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
      soloBtn.disabled = false;
    });
});

joinBtn.addEventListener('click', () => {
  joinBtn.disabled = true;
  soloBtn.disabled = true;
  const code = joinCodeInput.value.trim();
  void Room.join(code, joinNameInput.value || '玩家', iceConfigFromForm(), roomHandlers)
    .then((r) => {
      room = r;
      log(`已加入房間:${code}`);
    })
    .catch((err: unknown) => {
      log(`加入房間失敗:${String(err)}`);
      joinBtn.disabled = false;
      soloBtn.disabled = false;
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

log(`元素對照:${Object.entries(ELEMENT_NAMES).map(([k, v]) => `${k}=${v}`).join(' ')}`);
