// Phase 1+3 手動測試頁面。不是正式遊戲 UI(還沒接 Phaser),純粹用來驗證
// 建房/加入/tick 同步,以及 Phase 1 的塔防模擬邏輯本身有沒有正確運作。

import type { IceConfig } from './net/net';
import { HostLockstepEngine, ClientLockstepEngine, type LockstepHandlers } from './net/lockstep';
import { Room, type RoomHandlers } from './net/room';
import type { Action, PlayerInfo } from './net/protocol';
import { createGameRenderer } from './game/PhaserGame';
import { ALL_ELEMENTS, ELEMENT_NAMES, type Element } from './sim/elements';
import { LOCAL_PLAYER_ID, LocalEngine } from './sim/localEngine';
import { FP_SCALE } from './sim/map';
import { activeBonusWaveInfo, currentWaveNumber, ticksUntilNextWave, upcomingWaveDef } from './sim/monsters';
import { STARTING_LIVES, type SimulationState } from './sim/simulation';
import { describeTower } from './sim/towers';

const BASE_MATCH_CONFIG = {
  tickRateMs: 50,
  inputDelayTicks: 6,
  countdownMs: 3000,
};

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const menuScreenEl = $<HTMLElement>('menuScreen');
const gameScreenEl = $<HTMLElement>('gameScreen');
const backToMenuBtn = $<HTMLButtonElement>('backToMenuBtn');
const tabSoloEl = $<HTMLButtonElement>('tabSolo');
const tabMultiEl = $<HTMLButtonElement>('tabMulti');
const soloPanelEl = $<HTMLElement>('soloPanel');
const multiPanelEl = $<HTMLElement>('multiPanel');
const multiSetupEl = $<HTMLElement>('multiSetup');
const multiLobbyEl = $<HTMLElement>('multiLobby');
const soloBtn = $<HTMLButtonElement>('soloBtn');
const turnUserInput = $<HTMLInputElement>('turnUser');
const turnCredInput = $<HTMLInputElement>('turnCred');
const hostNameInput = $<HTMLInputElement>('hostName');
const hostDifficultySelect = $<HTMLSelectElement>('hostDifficulty');
const hostBtn = $<HTMLButtonElement>('hostBtn');
const roomCodeEl = $<HTMLSpanElement>('roomCode');
const joinNameInput = $<HTMLInputElement>('joinName');
const joinCodeInput = $<HTMLInputElement>('joinCode');
const joinBtn = $<HTMLButtonElement>('joinBtn');
const recentRoomsListEl = $<HTMLDataListElement>('recentRoomsList');
const inviteLinkInput = $<HTMLInputElement>('inviteLink');
const copyLinkBtn = $<HTMLButtonElement>('copyLinkBtn');
const rosterEl = $<HTMLUListElement>('roster');
const rosterCountEl = $<HTMLSpanElement>('rosterCount');
const readyBtn = $<HTMLButtonElement>('readyBtn');
const startBtn = $<HTMLButtonElement>('startBtn');
const startHintEl = $<HTMLParagraphElement>('startHint');
const leaveRoomBtn = $<HTMLButtonElement>('leaveRoomBtn');
const buildBarEl = $<HTMLDivElement>('buildBar');
const towerPanelEl = $<HTMLDivElement>('towerPanel');
const towerPanelElementEl = $<HTMLSpanElement>('towerPanelElement');
const towerPanelOwnerEl = $<HTMLSpanElement>('towerPanelOwner');
const towerPanelLevelEl = $<HTMLSpanElement>('towerPanelLevel');
const towerPanelDamageEl = $<HTMLSpanElement>('towerPanelDamage');
const towerPanelRangeEl = $<HTMLSpanElement>('towerPanelRange');
const towerPanelCooldownEl = $<HTMLSpanElement>('towerPanelCooldown');
const towerPanelStrategySelect = $<HTMLSelectElement>('towerPanelStrategy');
const towerUpgradeBtn = $<HTMLButtonElement>('towerUpgradeBtn');
const towerUpgradeCostEl = $<HTMLSpanElement>('towerUpgradeCost');
const towerSellBtn = $<HTMLButtonElement>('towerSellBtn');
const towerSellValueEl = $<HTMLSpanElement>('towerSellValue');
const towerDeselectBtn = $<HTMLButtonElement>('towerDeselectBtn');
const goldEl = $<HTMLSpanElement>('gold');
const livesEl = $<HTMLSpanElement>('lives');
const livesBarEl = $<HTMLDivElement>('livesBar');
const tickEl = $<HTMLSpanElement>('tick');
const nextWaveEl = $<HTMLSpanElement>('nextWave');
const waveNumberEl = $<HTMLSpanElement>('waveNumber');
const nextWaveElementEl = $<HTMLSpanElement>('nextWaveElement');
const bonusWaveEl = $<HTMLDivElement>('bonusWave');
const bestRecordEl = $<HTMLSpanElement>('bestRecord');
const checksumEl = $<HTMLSpanElement>('checksum');
const resultBannerEl = $<HTMLDivElement>('resultBanner');
const logEl = $<HTMLPreElement>('log');

let room: Room | null = null;
let hostEngine: HostLockstepEngine | null = null;
let clientEngine: ClientLockstepEngine | null = null;
let localEngine: LocalEngine | null = null;
let matchActive = false;
let currentTickRateMs = BASE_MATCH_CONFIG.tickRateMs;
let latestState: SimulationState | null = null;
let selectedTowerId: number | null = null;

function submitAction(action: Action): void {
  if (localEngine) localEngine.submitCommand(action);
  else if (room?.getRole() === 'host') hostEngine?.submitLocalCommand(action);
  else clientEngine?.submitLocalCommand(action);
}

/** 單人模式固定是 LOCAL_PLAYER_ID,連線模式是 room 給的 playerId。 */
function myPlayerId(): string {
  return room ? room.getMyPlayerId() : LOCAL_PLAYER_ID;
}

function displayNameFor(playerId: string): string {
  if (playerId === myPlayerId()) return '你';
  return room?.getRoster().find((p) => p.playerId === playerId)?.name ?? playerId;
}

const gameRenderer = createGameRenderer(
  'gameCanvas',
  (x, y) => {
    // GameScene 只有點到「空地」才會呼叫這裡——點到已經有塔的格子是選取,見下面 onTowerSelected。
    if (!matchActive || (!room && !localEngine)) return;
    submitAction({ kind: 'build_tower', params: { x, y, element: currentBuildElement() } });
  },
  (towerId) => {
    selectedTowerId = towerId;
    renderTowerPanel();
  },
);

/** WC3 式選取面板:顯示選到的塔的即時數值,升級/賣出按鈕才會真的送出指令。 */
function renderTowerPanel(): void {
  const tower = selectedTowerId !== null ? latestState?.towers.find((t) => t.id === selectedTowerId) : undefined;
  towerPanelEl.hidden = !tower;
  if (!tower) return;

  const stats = describeTower(tower);
  const myGold = latestState?.gold[myPlayerId()] ?? 0;
  towerPanelElementEl.textContent = `${ELEMENT_NAMES[tower.element]}塔`;
  towerPanelElementEl.className = `element-${tower.element}`;
  towerPanelOwnerEl.textContent = displayNameFor(tower.ownerId);
  towerPanelLevelEl.textContent = String(tower.level);
  towerPanelDamageEl.textContent = String(stats.damage);
  towerPanelRangeEl.textContent = (stats.rangeFp / FP_SCALE).toFixed(1);
  towerPanelCooldownEl.textContent = ((stats.cooldownTicks * currentTickRateMs) / 1000).toFixed(2);
  towerSellValueEl.textContent = String(stats.sellValue);
  towerPanelStrategySelect.value = tower.targetStrategy;

  // 升級不分誰的塔,誰都能幫忙出錢升級;賣塔限本人,避免動到別人的投資。
  if (stats.upgradeCost === null) {
    towerUpgradeCostEl.textContent = '已滿級';
    towerUpgradeBtn.disabled = true;
  } else {
    towerUpgradeCostEl.textContent = String(stats.upgradeCost);
    towerUpgradeBtn.disabled = myGold < stats.upgradeCost;
  }
  towerSellBtn.disabled = tower.ownerId !== myPlayerId();
}

towerUpgradeBtn.addEventListener('click', () => {
  if (selectedTowerId === null) return;
  submitAction({ kind: 'upgrade_tower', params: { towerId: selectedTowerId } });
});

towerSellBtn.addEventListener('click', () => {
  if (selectedTowerId === null) return;
  submitAction({ kind: 'sell_tower', params: { towerId: selectedTowerId } });
  gameRenderer.setSelectedTower(null);
});

towerDeselectBtn.addEventListener('click', () => {
  gameRenderer.setSelectedTower(null);
});

// 集火策略不分誰的塔,任何隊友都能改(跟升級一樣的共享邏輯),純戰術選擇不花錢。
towerPanelStrategySelect.addEventListener('change', () => {
  if (selectedTowerId === null) return;
  submitAction({
    kind: 'set_target_strategy',
    params: { towerId: selectedTowerId, strategy: towerPanelStrategySelect.value },
  });
});

// 快捷鍵:1~5 切建塔屬性、Delete/Backspace 賣掉選中的塔、Esc 取消選取。只在對局畫面生效,
// 且游標在任何輸入框裡(暱稱/房號等)時整個忽略,不然打字會被誤判成快捷鍵。
window.addEventListener('keydown', (ev) => {
  if (gameScreenEl.hidden) return;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') return;

  if (ev.key === 'Escape') {
    gameRenderer.setSelectedTower(null);
    return;
  }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedTowerId !== null && !towerSellBtn.disabled) {
    submitAction({ kind: 'sell_tower', params: { towerId: selectedTowerId } });
    gameRenderer.setSelectedTower(null);
    return;
  }
  const slot = Number(ev.key);
  if (Number.isInteger(slot) && slot >= 1 && slot <= 5) {
    const radios = buildBarEl.querySelectorAll<HTMLInputElement>('input[name="element"]');
    const radio = radios[slot - 1];
    if (radio) radio.checked = true;
  }
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

// 網址帶 ?room=xxx 的話直接幫忙填進「加入房間」欄位、切到多人頁籤——朋友點連結就不用手動輸入房號或選頁籤
const roomCodeFromUrl = new URLSearchParams(window.location.search).get('room');
if (roomCodeFromUrl) {
  joinCodeInput.value = roomCodeFromUrl;
  setMode('multi');
}

function showGameScreen(show: boolean): void {
  menuScreenEl.hidden = show;
  gameScreenEl.hidden = !show;
  if (show) backToMenuBtn.style.display = 'none';
}

function setMode(mode: 'solo' | 'multi'): void {
  tabSoloEl.classList.toggle('active', mode === 'solo');
  tabMultiEl.classList.toggle('active', mode === 'multi');
  soloPanelEl.hidden = mode !== 'solo';
  multiPanelEl.hidden = mode !== 'multi';
}

tabSoloEl.addEventListener('click', () => setMode('solo'));
tabMultiEl.addEventListener('click', () => setMode('multi'));

/** 建立/加入房間成功後,把設定表單換成房間 Lobby(不再兩者一起顯示)。 */
function showLobby(show: boolean): void {
  multiSetupEl.hidden = show;
  multiLobbyEl.hidden = !show;
}

/** 離開房間/房間結束(尚未開打前)時,回到多人連線的設定表單,清掉房間殘留狀態。 */
function resetToMultiSetup(): void {
  matchActive = false;
  room = null;
  hostEngine?.stop();
  hostEngine = null;
  clientEngine = null;
  showLobby(false);
  roomCodeEl.textContent = '-';
  inviteLinkInput.value = '';
  copyLinkBtn.disabled = true;
  rosterEl.innerHTML = '';
  rosterCountEl.textContent = '0';
  readyBtn.disabled = true;
  startBtn.disabled = true;
  startHintEl.textContent = '';
  soloBtn.disabled = false;
  hostBtn.disabled = false;
  joinBtn.disabled = false;
}

/** roster 裡的暱稱是別人打的(P2P 廣播過來),塞進 innerHTML 前一定要跳脫,不然可以注入任意標籤。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function renderRoster(roster: PlayerInfo[]): void {
  const myId = room?.getMyPlayerId();
  rosterCountEl.textContent = String(roster.length);
  rosterEl.innerHTML = roster
    .map((p) => {
      const you = p.playerId === myId ? '(你)' : '';
      const readyMark = p.ready
        ? '<span class="ready-yes"><svg class="icon"><use href="#icon-check" /></svg> 已準備</span>'
        : '<span class="ready-no"><svg class="icon"><use href="#icon-pending" /></svg> 未準備</span>';
      const elementNames = p.elements.map((e) => ELEMENT_NAMES[e]).join('');
      return `<li>slot ${p.slot}: ${escapeHtml(p.name)}${you} [${elementNames}] ${readyMark}</li>`;
    })
    .join('');
  const me = roster.find((p) => p.playerId === myId);
  readyBtn.innerHTML = me?.ready
    ? '<svg class="icon"><use href="#icon-close" /></svg> 取消準備'
    : '<svg class="icon"><use href="#icon-check" /></svg> 準備';
}

// 記住最近建立/加入過的房號(localStorage),下次打開「加入房間」的房號欄位就有原生瀏覽器自動完成清單可選。
const RECENT_ROOMS_KEY = 'wuxing-keep:recentRooms';
const MAX_RECENT_ROOMS = 5;

function loadRecentRooms(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ROOMS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function renderRecentRooms(codes: string[]): void {
  recentRoomsListEl.innerHTML = codes.map((code) => `<option value="${escapeHtml(code)}"></option>`).join('');
}

function rememberRecentRoom(code: string): void {
  const next = [code, ...loadRecentRooms().filter((c) => c !== code)].slice(0, MAX_RECENT_ROOMS);
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(next));
  renderRecentRooms(next);
}

/** 目前用哪一個元素選擇區塊的 checkbox 群組(solo 選單 vs 多人選單),回傳玩家勾選的屬性(至少 1 個)。 */
function selectedElements(scope: HTMLElement): Element[] {
  return ALL_ELEMENTS.filter(
    (el) => scope.querySelector<HTMLInputElement>(`input[value="${el}"]`)?.checked,
  );
}

function selectedDifficulty(container: HTMLElement): number {
  const checked = container.querySelector<HTMLInputElement>('input[name="difficulty"]:checked');
  return Number(checked?.value) || 100;
}

/** 目前建塔列選到的屬性(對局中,建塔列已經被 populateBuildBar 依玩家自己的選擇動態產生過)。 */
function currentBuildElement(): Element {
  const checked = buildBarEl.querySelector<HTMLInputElement>('input[name="element"]:checked');
  return (checked?.value as Element | undefined) ?? 'metal';
}

/** 對局開始後,建塔列只顯示玩家自己選好的屬性,不是每次都五選一。 */
function populateBuildBar(elements: Element[]): void {
  buildBarEl.innerHTML = elements
    .map(
      (el, i) => `
        <input type="radio" id="build-${el}" name="element" value="${el}" ${i === 0 ? 'checked' : ''} />
        <label for="build-${el}" class="element-${el}">${ELEMENT_NAMES[el]}</label>
      `,
    )
    .join('');
}

// 單人/連線都通用的「最佳紀錄」——存在這台瀏覽器的 localStorage,跟房間/連線無關。
interface BestRecord {
  wave: number;
  cleared: boolean;
}

const BEST_RECORD_KEY = 'wuxing-keep:bestRecord';

function loadBestRecord(): BestRecord | null {
  try {
    const raw = localStorage.getItem(BEST_RECORD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const o = parsed as Partial<BestRecord>;
    if (typeof o.wave === 'number' && typeof o.cleared === 'boolean') return { wave: o.wave, cleared: o.cleared };
    return null;
  } catch {
    return null;
  }
}

function renderBestRecord(record: BestRecord | null): void {
  bestRecordEl.textContent = !record
    ? '尚無紀錄'
    : record.cleared
      ? `全破!(第 ${record.wave} 波達成)`
      : `第 ${record.wave} 波`;
}

function saveBestRecordIfBetter(candidate: BestRecord): void {
  const current = loadBestRecord();
  const better =
    !current ||
    (candidate.cleared && !current.cleared) ||
    (candidate.cleared === current.cleared && candidate.wave > current.wave);
  if (!better) return;
  localStorage.setItem(BEST_RECORD_KEY, JSON.stringify(candidate));
  renderBestRecord(candidate);
}

function renderLivesBar(lives: number): void {
  const ratio = Math.max(0, Math.min(1, lives / STARTING_LIVES));
  livesBarEl.style.width = `${ratio * 100}%`;
  livesBarEl.style.background = ratio > 0.5 ? '#3a9d3a' : ratio > 0.25 ? '#d4af37' : '#e05a2b';
  livesBarEl.parentElement?.classList.toggle('lives-critical', ratio <= 0.25);
}

/** 對局開始/回選單時清掉上一場的勝敗橫幅跟樣式,不然舊的發光顏色會殘留。 */
function resetResultBanner(): void {
  resultBannerEl.textContent = '';
  resultBannerEl.classList.remove('result-victory', 'result-defeat');
}

function showResult(text: string, variant: 'victory' | 'defeat'): void {
  resultBannerEl.textContent = text;
  resultBannerEl.classList.remove('result-victory', 'result-defeat');
  resultBannerEl.classList.add(`result-${variant}`);
}

function renderWaveHud(tick: number): void {
  waveNumberEl.textContent = String(currentWaveNumber(tick));
  const ticksLeft = ticksUntilNextWave(tick);
  nextWaveEl.textContent =
    ticksLeft === null ? '最後一波' : `${Math.ceil((ticksLeft * currentTickRateMs) / 1000)}s`;
  const upcoming = upcomingWaveDef(tick);
  nextWaveElementEl.innerHTML = !upcoming
    ? '—'
    : upcoming.isBoss
      ? `<svg class="icon" style="color: var(--accent)"><use href="#icon-crown" /></svg> ${ELEMENT_NAMES[upcoming.element]}首領`
      : ELEMENT_NAMES[upcoming.element];

  const bonus = activeBonusWaveInfo(tick);
  bonusWaveEl.innerHTML = bonus
    ? `<svg class="icon"><use href="#icon-star" /></svg> 加碼波!剩 ${Math.ceil((bonus.ticksLeft * currentTickRateMs) / 1000)}s 內清光可得 ${bonus.bonusGold} 金幣`
    : '';
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
    latestState = state;
    tickEl.textContent = String(state.tick);
    checksumEl.textContent = state.checksum;
    goldEl.textContent = String(state.gold[myPlayerId()] ?? 0);
    livesEl.textContent = String(state.lives);
    renderLivesBar(state.lives);
    renderWaveHud(state.tick);
    gameRenderer.renderState(state);
    renderTowerPanel();
    if (state.gameOver) {
      showResult('守備失敗(生命歸零)', 'defeat');
      saveBestRecordIfBetter({ wave: currentWaveNumber(state.tick), cleared: false });
      endLocalMatch();
      backToMenuBtn.style.display = 'inline-block';
    } else if (state.victory) {
      showResult('守備成功!全部波次清空', 'victory');
      saveBestRecordIfBetter({ wave: currentWaveNumber(state.tick), cleared: true });
      endLocalMatch();
      backToMenuBtn.style.display = 'inline-block';
    }
  },
  onWaitingForTick: () => {
    // MVP 測試頁先不特別顯示等待狀態,tick 數字停住不動就代表在等
  },
};

const roomHandlers: RoomHandlers = {
  onRosterChanged: (roster) => {
    renderRoster(roster);
    readyBtn.disabled = false;
    const isHost = room?.getRole() === 'host';
    const allReady = roster.length > 0 && roster.every((p) => p.ready);
    startBtn.disabled = !isHost || !allReady;
    startHintEl.textContent = isHost ? (allReady ? '所有人已準備,可以開始!' : '等待所有人準備...') : '等待房主開始對局...';
  },
  onMatchStarted: (payload) => {
    log(`對局開始,seed=${payload.seed}`);
    matchActive = true;
    currentTickRateMs = payload.tickRateMs;
    resetResultBanner();
    showGameScreen(true);
    gameRenderer.setSelectedTower(null);
    gameRenderer.resetCamera();
    if (!room) return;
    const me = payload.roster.find((p) => p.playerId === room?.getMyPlayerId());
    populateBuildBar(me?.elements ?? ['metal']);
    if (room.getRole() === 'host') {
      hostEngine = new HostLockstepEngine(
        room,
        {
          tickRateMs: payload.tickRateMs,
          inputDelayTicks: payload.inputDelayTicks,
          countdownMs: payload.countdownMs,
          difficultyPercent: payload.difficultyPercent,
        },
        payload.seed,
        lockstepHandlers,
      );
      hostEngine.start();
    } else {
      clientEngine = new ClientLockstepEngine(room, payload.seed, payload.difficultyPercent, lockstepHandlers);
    }
  },
  onRejected: (reason) => log(`加入被拒絕:${reason}`),
  onRoomEnded: (reasonText) => {
    log(`房間結束:${reasonText}`);
    if (matchActive) {
      // 對局進行中房主斷線:MVP 決定直接結束對局,遊戲畫面留著讓玩家按「回到選單」自己收尾
      matchActive = false;
      hostEngine?.stop();
      hostEngine = null;
      clientEngine = null;
      readyBtn.disabled = true;
      startBtn.disabled = true;
      backToMenuBtn.style.display = 'inline-block';
    } else {
      // 還在 Lobby 階段就斷線(例如房主關掉分頁):直接退回設定表單重新來過
      resetToMultiSetup();
    }
  },
  onCommand: (cmd) => hostEngine?.enqueueRemoteCommand(cmd),
  onTick: (tick) => clientEngine?.receiveTick(tick),
};

soloBtn.addEventListener('click', () => {
  const elements = selectedElements(soloPanelEl);
  if (elements.length === 0) {
    log('請至少選一種屬性才能開始');
    return;
  }
  soloBtn.disabled = true;
  hostBtn.disabled = true;
  joinBtn.disabled = true;
  matchActive = true;
  currentTickRateMs = BASE_MATCH_CONFIG.tickRateMs;
  resetResultBanner();
  showGameScreen(true);
  gameRenderer.setSelectedTower(null);
  gameRenderer.resetCamera();
  populateBuildBar(elements);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  localEngine = new LocalEngine(
    seed,
    BASE_MATCH_CONFIG.tickRateMs,
    lockstepHandlers,
    selectedDifficulty(soloPanelEl),
    elements,
  );
  localEngine.start();
  log(`單人模式開始,seed=${seed}`);
});

backToMenuBtn.addEventListener('click', () => {
  showGameScreen(false);
  resetResultBanner();
  gameRenderer.setSelectedTower(null);
  if (room) {
    room.destroy();
    resetToMultiSetup();
  }
});

hostBtn.addEventListener('click', () => {
  const elements = selectedElements(multiPanelEl);
  if (elements.length === 0) {
    log('請至少選一種屬性才能建立房間');
    return;
  }
  hostBtn.disabled = true;
  soloBtn.disabled = true;
  void Room.host(hostNameInput.value || '房主', elements, iceConfigFromForm(), roomHandlers)
    .then(({ room: r, roomCode }) => {
      room = r;
      roomCodeEl.textContent = roomCode;
      inviteLinkInput.value = buildInviteLink(roomCode);
      copyLinkBtn.disabled = false;
      showLobby(true);
      rememberRecentRoom(roomCode);
      log(`房間已建立:${roomCode}`);
    })
    .catch((err: unknown) => {
      log(`建立房間失敗:${String(err)}`);
      hostBtn.disabled = false;
      soloBtn.disabled = false;
    });
});

joinBtn.addEventListener('click', () => {
  const elements = selectedElements(multiPanelEl);
  if (elements.length === 0) {
    log('請至少選一種屬性才能加入房間');
    return;
  }
  joinBtn.disabled = true;
  soloBtn.disabled = true;
  const code = joinCodeInput.value.trim();
  void Room.join(code, joinNameInput.value || '玩家', elements, iceConfigFromForm(), roomHandlers)
    .then((r) => {
      room = r;
      roomCodeEl.textContent = code;
      inviteLinkInput.value = buildInviteLink(code);
      copyLinkBtn.disabled = false;
      showLobby(true);
      rememberRecentRoom(code);
      log(`已加入房間:${code}`);
    })
    .catch((err: unknown) => {
      log(`加入房間失敗:${String(err)}`);
      joinBtn.disabled = false;
      soloBtn.disabled = false;
    });
});

readyBtn.addEventListener('click', () => {
  if (!room) return;
  const me = room.getRoster().find((p) => p.playerId === room?.getMyPlayerId());
  room.setReady(!me?.ready);
});

leaveRoomBtn.addEventListener('click', () => {
  room?.destroy();
  resetToMultiSetup();
  log('已離開房間');
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
  room?.startMatch({ ...BASE_MATCH_CONFIG, difficultyPercent: Number(hostDifficultySelect.value) || 100 });
});

renderBestRecord(loadBestRecord());
renderRecentRooms(loadRecentRooms());
log(`元素對照:${Object.entries(ELEMENT_NAMES).map(([k, v]) => `${k}=${v}`).join(' ')}`);
