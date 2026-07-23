// Phase 1+3 手動測試頁面。不是正式遊戲 UI(還沒接 Phaser),純粹用來驗證
// 建房/加入/tick 同步,以及 Phase 1 的塔防模擬邏輯本身有沒有正確運作。

import type { IceConfig } from './net/net';
import { HostLockstepEngine, ClientLockstepEngine, type LockstepHandlers } from './net/lockstep';
import { Room, type MatchConfig, type RoomHandlers } from './net/room';
import type { Action, PlayerInfo } from './net/protocol';
import { createGameRenderer, type HoverInfo } from './game/PhaserGame';
import { isMultiplayer, ownerColorCss } from './game/playerColors';
import { ALL_ELEMENTS, ELEMENT_NAMES, type Element } from './sim/elements';
import { LOCAL_PLAYER_ID, LocalEngine } from './sim/localEngine';
import { DEFAULT_MAP_ID, FP_SCALE, isOnPath, MAP_DEFS, setActiveMap } from './sim/map';
import {
  SKILL_DEFS,
  SKILL_IDS,
  skillCooldownRemaining,
  type SkillId,
} from './sim/skills';
import { STATUS_DESCRIPTIONS, STATUS_NAMES, type StatusKind } from './sim/statuses';
import { ABILITY_DESCRIPTIONS, ABILITY_NAMES, type MonsterAbility } from './sim/monsters';
import {
  activeBonusWaveInfo,
  currentWaveNumber,
  currentWaveNumberEndless,
  ticksUntilNextWave,
  ticksUntilNextWaveEndless,
  upcomingWaveDef,
  upcomingWaveDefEndless,
} from './sim/monsters';
import {
  RESOURCE_BUILDING_COST,
  MAX_RUNE_TOTEM_LEVEL,
  RESOURCE_BUILDING_INCOME,
  RESOURCE_BUILDING_INTERVAL_TICKS,
  RUNE_TOTEM_COST,
  RUNE_TOTEM_DAMAGE_BONUS_PERCENT,
  RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED,
  RUNE_TOTEM_HASTE_PERCENT,
  RUNE_TOTEM_RANGE_FP,
  RUNE_TOTEM_UPGRADE_COST,
  TRAP_COST,
  TRAP_SLOW_PERCENT_BY_LEVEL,
  trapUpgradeCost,
} from './sim/placements';
import {
  EMERGENCY_HEAL_COST,
  EMERGENCY_HEAL_THRESHOLD,
  STARTING_LIVES,
  effectiveWaveTick,
  type SimulationState,
} from './sim/simulation';
import {
  describeTower,
  DUAL_ELEMENT_MIN_LEVEL,
  secondElementCost,
  TOWER_CHARACTER_NAMES,
  TOWER_DEFS,
  towerDisplayName,
  UPGRADE_PATH_LEVEL,
  UPGRADE_PATH_NAMES,
  type UpgradePath,
} from './sim/towers';

// 頁面上刻意不放 tick/checksum 這種除錯資訊(不是給一般玩家看的東西),但多人連線真的跑飛
// 時還是需要比對兩邊的值——掛在 window 上,要查的時候在瀏覽器主控台(F12)打
// window.__wuxingDebug 看,平常不會佔畫面。
declare global {
  interface Window {
    __wuxingDebug?: { tick: number; checksum: string };
  }
}

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
const subTabHostEl = $<HTMLButtonElement>('subTabHost');
const subTabJoinEl = $<HTMLButtonElement>('subTabJoin');
const hostSectionEl = $<HTMLElement>('hostSection');
const joinSectionEl = $<HTMLElement>('joinSection');
const multiSetupEl = $<HTMLElement>('multiSetup');
const multiLobbyEl = $<HTMLElement>('multiLobby');
const soloBtn = $<HTMLButtonElement>('soloBtn');
const turnUserInput = $<HTMLInputElement>('turnUser');
const turnCredInput = $<HTMLInputElement>('turnCred');
const hostNameInput = $<HTMLInputElement>('hostName');
const hostDifficultySelect = $<HTMLSelectElement>('hostDifficulty');
const hostEndlessModeCheckbox = $<HTMLInputElement>('hostEndlessMode');
const hostIndividualLivesModeCheckbox = $<HTMLInputElement>('hostIndividualLivesMode');
const soloEndlessModeCheckbox = $<HTMLInputElement>('soloEndlessMode');
const soloMapSelect = $<HTMLSelectElement>('soloMap');
const soloMapHintEl = $<HTMLParagraphElement>('soloMapHint');
const hostMapSelect = $<HTMLSelectElement>('hostMap');
const hostMapHintEl = $<HTMLParagraphElement>('hostMapHint');
const skillBarEl = $<HTMLDivElement>('skillBar');
const skillHintEl = $<HTMLDivElement>('skillHint');
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
const toastEl = $<HTMLDivElement>('toast');
const floatingBuildMenuEl = $<HTMLDivElement>('floatingBuildMenu');
const floatingBuildBackdropEl = $<HTMLDivElement>('floatingBuildBackdrop');
const choiceModalOverlayEl = $<HTMLDivElement>('choiceModalOverlay');
const choiceModalTitleEl = $<HTMLHeadingElement>('choiceModalTitle');
const choiceModalOptionsEl = $<HTMLDivElement>('choiceModalOptions');
const choiceModalCancelBtn = $<HTMLButtonElement>('choiceModalCancelBtn');
const towerPanelEl = $<HTMLDivElement>('towerPanel');
const towerPanelElementEl = $<HTMLSpanElement>('towerPanelElement');
const towerPanelOwnerEl = $<HTMLSpanElement>('towerPanelOwner');
const towerPanelLevelEl = $<HTMLSpanElement>('towerPanelLevel');
const towerPanelDamageEl = $<HTMLSpanElement>('towerPanelDamage');
const towerPanelRangeEl = $<HTMLSpanElement>('towerPanelRange');
const towerPanelCooldownEl = $<HTMLSpanElement>('towerPanelCooldown');
const towerPanelPathRowEl = $<HTMLDivElement>('towerPanelPathRow');
const towerPanelPathEl = $<HTMLSpanElement>('towerPanelPath');
const towerPanelAdjacencyRowEl = $<HTMLDivElement>('towerPanelAdjacencyRow');
const towerPanelTotemRowEl = $<HTMLDivElement>('towerPanelTotemRow');
const towerPanelTotemTextEl = $<HTMLSpanElement>('towerPanelTotemText');
const towerPanelStrategySelect = $<HTMLSelectElement>('towerPanelStrategy');
const towerUpgradeBtn = $<HTMLButtonElement>('towerUpgradeBtn');
const towerUpgradeCostEl = $<HTMLSpanElement>('towerUpgradeCost');
const towerSecondElementBtn = $<HTMLButtonElement>('towerSecondElementBtn');
const towerSecondElementCostEl = $<HTMLSpanElement>('towerSecondElementCost');
const towerSellBtn = $<HTMLButtonElement>('towerSellBtn');
const towerSellValueEl = $<HTMLSpanElement>('towerSellValue');
const towerDeselectBtn = $<HTMLButtonElement>('towerDeselectBtn');
const goldEl = $<HTMLSpanElement>('gold');
const livesEl = $<HTMLSpanElement>('lives');
const livesBarEl = $<HTMLDivElement>('livesBar');
const teamLivesStatEl = $<HTMLDivElement>('teamLivesStat');
const pathLivesStatsEl = $<HTMLDivElement>('pathLivesStats');
const emergencyHealBtn = $<HTMLButtonElement>('emergencyHealBtn');
const nextWaveEl = $<HTMLSpanElement>('nextWave');
const waveNumberEl = $<HTMLSpanElement>('waveNumber');
const nextWaveElementEl = $<HTMLSpanElement>('nextWaveElement');
const bonusWaveEl = $<HTMLDivElement>('bonusWave');
const skipWaveBtn = $<HTMLButtonElement>('skipWaveBtn');
const objectTooltipEl = $<HTMLDivElement>('objectTooltip');
const hudCompactBtn = $<HTMLButtonElement>('hudCompactBtn');
const scoreboardBtn = $<HTMLButtonElement>('scoreboardBtn');
const scoreboardOverlayEl = $<HTMLDivElement>('scoreboardOverlay');
const scoreboardBodyEl = $<HTMLTableSectionElement>('scoreboardBody');
const scoreboardMetaEl = $<HTMLDivElement>('scoreboardMeta');
const bestRecordEl = $<HTMLSpanElement>('bestRecord');
const dailyBestEl = $<HTMLSpanElement>('dailyBest');
const achievementsEl = $<HTMLDivElement>('achievements');
const resultBannerEl = $<HTMLDivElement>('resultBanner');

let room: Room | null = null;
let hostEngine: HostLockstepEngine | null = null;
let clientEngine: ClientLockstepEngine | null = null;
let localEngine: LocalEngine | null = null;
let matchActive = false;
let currentTickRateMs = BASE_MATCH_CONFIG.tickRateMs;
let latestState: SimulationState | null = null;
let selectedTowerId: number | null = null;
/** 對局開始當下的設定,換房主時新蓋的 HostLockstepEngine 要用同一份(見 attemptRehost 流程),
 * 不會因為換房主而改變(tickRateMs 等等是整場對局固定的)。 */
let lastMatchConfig: MatchConfig | null = null;
/** 避免同時收到好幾次「跟房主的連線斷了」事件(理論上只會有一條 hostConn,但保守起見防重入)。 */
let rehostInProgress = false;

/**
 * 玩家點了技能按鈕、正在等他點地圖決定施放位置的狀態(null = 沒有在施放模式)。
 * 施放模式下點地圖不會開建造選單,而是直接送出 cast_skill 指令,見 onTilePlaced。
 */
let armedSkill: SkillId | null = null;

// ---- SVG 圖示對應(<symbol> 定義在 index.html 的 <body> 開頭)----
// 放在 main.ts 而不是 sim/ 底下的模組:圖示純粹是顯示層的事,模擬層不該知道 UI 用什麼圖。

const SKILL_ICONS: Record<SkillId, string> = {
  meteor: 'icon-meteor',
  frost: 'icon-frost',
  warcry: 'icon-warcry',
};

const ABILITY_ICONS: Record<MonsterAbility, string | null> = {
  none: null,
  healer: 'icon-healer',
  shield: 'icon-shield',
  splitter: 'icon-split',
  aura: 'icon-aura',
  bomber: 'icon-bomb',
};

const STATUS_ICONS: Record<StatusKind, string> = {
  burn: 'icon-burn',
  chill: 'icon-chill',
  entangle: 'icon-entangle',
  sunder: 'icon-sunder',
  knockback: 'icon-knockback',
};

/**
 * 狀態圖示的顏色。刻意跟 GameScene.ts 的 statusTintColor()/STATUS_TEXT_COLORS 同一套配色——
 * 玩家在 tooltip 看到的顏色,要跟他在地圖上看到那隻怪被染成的顏色一致,才建立得起關聯。
 */
const STATUS_UI_COLORS: Record<StatusKind, string> = {
  burn: '#ff9b6b',
  chill: '#8ecdff',
  entangle: '#7ee08a',
  sunder: '#ffd27e',
  knockback: '#e8e8ea',
};

/** 能力圖示的顏色,同樣對齊 GameScene.ts 的 ABILITY_RING_COLORS(怪物外圈那個環)。 */
const ABILITY_UI_COLORS: Record<MonsterAbility, string> = {
  none: '#e8e8ea',
  healer: '#7ee08a',
  shield: '#6ec6ff',
  splitter: '#c98aff',
  aura: '#ffe98a',
  bomber: '#ff6b6b',
};

/** 產生一個 `<svg class="icon">` 標記。color 是 CSS 顏色字串(通常是 var(--xxx)),省略就繼承文字顏色。 */
function iconMarkup(symbolId: string, color?: string): string {
  return `<svg class="icon"${color ? ` style="color: ${color}"` : ''}><use href="#${symbolId}" /></svg>`;
}

// ---- 地圖選擇 ----
// 兩個下拉選單(單人/建房)共用同一份 MAP_DEFS,選項是程式產生的,不是寫死在 HTML 裡——
// 之後新增地圖只要往 MAP_DEFS 加一筆,兩邊的選單跟說明文字都會自動跟上。
function populateMapSelect(select: HTMLSelectElement, hint: HTMLElement): void {
  select.innerHTML = '';
  for (const def of MAP_DEFS) {
    const option = document.createElement('option');
    option.value = def.id;
    option.textContent = `${def.name}(${def.paths.length} 條路徑)`;
    select.appendChild(option);
  }
  select.value = DEFAULT_MAP_ID;
  const syncHint = () => {
    hint.textContent = MAP_DEFS.find((m) => m.id === select.value)?.description ?? '';
  };
  select.addEventListener('change', syncHint);
  syncHint();
}

populateMapSelect(soloMapSelect, soloMapHintEl);
populateMapSelect(hostMapSelect, hostMapHintEl);

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

/** mm:ss 格式,記分板的「已進行時間」用。 */
function formatElapsed(tick: number): string {
  const totalSeconds = Math.floor((tick * currentTickRateMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 記分板(參考 WC3):按傷害由高到低排序,只有按鈕開著時才畫,tick 更新時才不用每次都算。
 * 波次/已進行時間跟玩家列表寫在同一塊,不用另外切去看 HUD。 */
function renderScoreboard(): void {
  if (!latestState) return;
  const state = latestState;
  scoreboardMetaEl.textContent = `第 ${currentWaveNumberFor(state)} 波 · 已進行 ${formatElapsed(state.tick)}`;
  const rows = Object.keys(state.gold)
    .map((playerId) => {
      const stats = state.playerStats[playerId] ?? { damageDealt: 0, kills: 0 };
      const towerCount = state.towers.filter((t) => t.ownerId === playerId).length;
      return {
        playerId,
        name: displayNameFor(playerId),
        gold: state.gold[playerId] ?? 0,
        towerCount,
        kills: stats.kills,
        damage: stats.damageDealt,
      };
    })
    .sort((a, b) => b.damage - a.damage);

  // 多人才需要用顏色點區分「這是誰」——單人只有自己一列,不用畫。跟塔/陷阱/資源建築底部
  // 的識別色是同一套配色(ownerColorCss()),同一個玩家在小地圖、塔、記分板上看到的顏色一致。
  const multiplayer = isMultiplayer(state);
  scoreboardBodyEl.innerHTML = rows
    .map(
      (r, i) => `
        <tr class="${r.playerId === myPlayerId() ? 'scoreboard-me' : ''}">
          <td><span class="scoreboard-rank ${i === 0 ? 'rank-1' : ''}">${i + 1}</span></td>
          <td>${multiplayer ? `<span class="scoreboard-dot" style="background:${ownerColorCss(state, r.playerId)}"></span>` : ''}${escapeHtml(r.name)}${
            multiplayer && r.playerId !== myPlayerId()
              ? `<button class="scoreboard-gift-btn" type="button" data-gift-to="${escapeHtml(r.playerId)}" title="送金幣給${escapeHtml(r.name)}"><svg class="icon"><use href="#icon-gift" /></svg></button>`
              : ''
          }</td>
          <td>${r.gold}</td>
          <td>${r.towerCount}</td>
          <td>${r.kills}</td>
          <td>${r.damage}</td>
        </tr>
      `,
    )
    .join('');
}

scoreboardBtn.addEventListener('click', () => {
  const showing = scoreboardOverlayEl.classList.toggle('show');
  scoreboardBtn.textContent = showing ? '關閉記分板' : '記分板';
  if (showing) renderScoreboard();
});

/** 互助道具:金幣禮物——記分板每列(自己除外)的禮物按鈕點下去,跳選單選金額,送出 gift_gold 指令。 */
function showGiftGoldModal(toPlayerId: string): void {
  const toName = displayNameFor(toPlayerId);
  const amounts = [50, 100, 200];
  showChoiceModal(
    `送金幣給 ${toName}`,
    amounts.map((amount) => ({
      label: `${amount} 金幣`,
      disabled: (latestState?.gold[myPlayerId()] ?? 0) < amount,
      onChoose: () => {
        if ((latestState?.gold[myPlayerId()] ?? 0) < amount) {
          showToast('金幣不足,沒辦法送這麼多');
          return;
        }
        submitAction({ kind: 'gift_gold', params: { toPlayerId, amount } });
      },
    })),
  );
}

// 記分板內容是整段 innerHTML 重畫的(見 renderScoreboard()),禮物按鈕改用事件代理(委派到
// 整個 tbody 上),不用每次重畫後重新綁定個別按鈕的監聽器。
scoreboardBodyEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.scoreboard-gift-btn');
  if (!btn?.dataset.giftTo) return;
  showGiftGoldModal(btn.dataset.giftTo);
});

/** 互助道具:緊急補命——團隊模式的按鈕是固定的 DOM 元素;個人生命模式的按鈕是動態產生的,用事件代理。 */
emergencyHealBtn.addEventListener('click', () => {
  if ((latestState?.gold[myPlayerId()] ?? 0) < EMERGENCY_HEAL_COST) {
    showToast(`金幣不足!緊急補命需要 ${EMERGENCY_HEAL_COST} 金幣`);
    return;
  }
  submitAction({ kind: 'emergency_heal', params: {} });
});

pathLivesStatsEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-heal-path]');
  if (!btn?.dataset.healPath) return;
  if ((latestState?.gold[myPlayerId()] ?? 0) < EMERGENCY_HEAL_COST) {
    showToast(`金幣不足!緊急補命需要 ${EMERGENCY_HEAL_COST} 金幣`);
    return;
  }
  submitAction({ kind: 'emergency_heal', params: { pathId: Number(btn.dataset.healPath) } });
});

/**
 * 蓋塔選單要列出哪些屬性——固定顯示玩家自己允許的全部屬性,不再隨機抽 3 個
 * (2026-07-16 改的,原本是 WC3 英雄選擇式隨機抽最多 3 個,玩家反應想要固定看到全部)。
 * 順序照 ALL_ELEMENTS 固定順序,不用洗牌。
 */
function buildableTowerElements(): readonly Element[] {
  return latestState?.playerElements[myPlayerId()] ?? ALL_ELEMENTS;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 短暫浮現的訊息提示(例如金幣不足),淡入後停留一下再淡出,再次呼叫會重新計時。 */
function showToast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

interface ChoiceOption {
  label: string;
  sublabel?: string;
  disabled?: boolean;
  /**
   * 這個選項是**因為金幣不足**才不能選(而不是其他條件不符)。單純的 disabled 只是變淡,
   * 玩家看不出到底是「還缺什麼條件」還是「只差錢」——標成 true 會另外上紅色調,
   * 讓「存夠錢就能選」這件事一眼看得出來。
   */
  unaffordable?: boolean;
  onChoose: () => void;
}

/** 通用選擇彈窗:蓋塔的隨機英雄選擇、升級到分岐級選路線都共用這個。點取消或背景不會做任何事。 */
function showChoiceModal(title: string, options: ChoiceOption[]): void {
  choiceModalTitleEl.textContent = title;
  choiceModalOptionsEl.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-option';
    btn.disabled = opt.disabled ?? false;
    // 錢不夠跟其他不能選的原因要分得出來(見 ChoiceOption.unaffordable)
    if (opt.unaffordable) btn.classList.add('cost-unaffordable');
    btn.innerHTML = opt.sublabel
      ? `${escapeHtml(opt.label)}<small>${escapeHtml(opt.sublabel)}</small>`
      : escapeHtml(opt.label);
    btn.addEventListener('click', () => {
      hideChoiceModal();
      opt.onChoose();
    });
    choiceModalOptionsEl.appendChild(btn);
  }
  choiceModalOverlayEl.classList.add('show');
}

function hideChoiceModal(): void {
  choiceModalOverlayEl.classList.remove('show');
}

choiceModalCancelBtn.addEventListener('click', hideChoiceModal);

/** 建塔列下方的花費提示,金幣不夠時變色——跟著目前選的建造模式 + 自己的金幣即時更新。 */
/**
 * 浮動建造選單:定位在點擊處附近的畫布像素座標(換算成頁面座標),不像以前的建塔列
 * 固定佔用畫面底部一整塊。floatingBuildBackdropEl 是透明的點擊接收層,點選單以外的
 * 地方會關掉選單,但不會讓畫面變暗(跟 showChoiceModal 的全螢幕黑幕彈窗不同用途)。
 */
function showFloatingBuildMenu(canvasX: number, canvasY: number, options: ChoiceOption[]): void {
  floatingBuildMenuEl.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-option';
    btn.disabled = opt.disabled ?? false;
    // 錢不夠跟其他不能選的原因要分得出來(見 ChoiceOption.unaffordable)
    if (opt.unaffordable) btn.classList.add('cost-unaffordable');
    btn.innerHTML = opt.sublabel
      ? `${escapeHtml(opt.label)}<small>${escapeHtml(opt.sublabel)}</small>`
      : escapeHtml(opt.label);
    btn.addEventListener('click', () => {
      hideFloatingBuildMenu();
      opt.onChoose();
    });
    floatingBuildMenuEl.appendChild(btn);
  }

  const canvasRect = document.getElementById('gameCanvas')?.getBoundingClientRect();
  const pageX = (canvasRect?.left ?? 0) + canvasX;
  const pageY = (canvasRect?.top ?? 0) + canvasY;
  // 夾在視窗範圍內,避免選單超出畫面邊緣被裁掉看不到(選單實際大小要等內容塞進去後才知道,
  // 這裡用保守的估計值當夾取上限,足夠應付目前最多 8 個選項的版面:5 種屬性都固定顯示
  // 不再隨機抽 3 個,加上雙屬性塔、資源建築、符文圖騰)。
  const MENU_WIDTH_GUESS = 180;
  const MENU_HEIGHT_GUESS = 450;
  floatingBuildMenuEl.style.left = `${Math.max(8, Math.min(pageX, window.innerWidth - MENU_WIDTH_GUESS))}px`;
  floatingBuildMenuEl.style.top = `${Math.max(8, Math.min(pageY, window.innerHeight - MENU_HEIGHT_GUESS))}px`;

  floatingBuildMenuEl.classList.add('show');
  floatingBuildBackdropEl.classList.add('show');
}

function hideFloatingBuildMenu(): void {
  floatingBuildMenuEl.classList.remove('show');
  floatingBuildBackdropEl.classList.remove('show');
}

floatingBuildBackdropEl.addEventListener('click', hideFloatingBuildMenu);

function hideObjectTooltip(): void {
  objectTooltipEl.classList.remove('show');
}

/**
 * 滑鼠移到塔/怪物/陷阱/資源建築上面浮動顯示的說明,跟著游標定位(換算成頁面座標,同
 * showFloatingBuildMenu() 的做法)。GameScene.ts 的 onHoverInfoChanged 每影格都會呼叫一次
 * (不只在換了不同物件時才呼叫),塔的攻速/怪物血量這些數值才能跟著即時更新。
 */
function renderObjectTooltip(info: HoverInfo | null, canvasX: number, canvasY: number): void {
  if (!info || !latestState) {
    hideObjectTooltip();
    return;
  }
  const state = latestState;
  let html: string;

  if (info.kind === 'tower') {
    const tower = state.towers.find((t) => t.id === info.id);
    if (!tower) {
      hideObjectTooltip();
      return;
    }
    const stats = describeTower(tower, state.towers, state.runeTotems);
    const rows = [
      `<div class="tooltip-row">攻擊力 <b>${stats.damage}</b> · 範圍 <b>${(stats.rangeFp / FP_SCALE).toFixed(1)}</b> 格 · 攻速 <b>${((stats.cooldownTicks * currentTickRateMs) / 1000).toFixed(2)}s</b></div>`,
    ];
    if (tower.upgradePath !== 'none') rows.push(`<div class="tooltip-row">${escapeHtml(UPGRADE_PATH_NAMES[tower.upgradePath])}</div>`);
    if (stats.adjacencyBonusActive) rows.push(`<div class="tooltip-row" style="color: var(--accent)">相生加速中(+15% 攻速)</div>`);
    if (stats.totemDamageBonusPercent > 0) {
      rows.push(`<div class="tooltip-row" style="color: var(--accent)">圖騰增傷中(+${stats.totemDamageBonusPercent}% 攻擊力)</div>`);
    }
    if (stats.totemHastePercent > 0) {
      rows.push(`<div class="tooltip-row" style="color: var(--accent)">圖騰加速中(+${stats.totemHastePercent}% 攻速)</div>`);
    }
    if (stats.warcryActive) {
      rows.push(`<div class="tooltip-row" style="color: var(--accent)">戰吼生效中(大幅提升攻速)</div>`);
    }
    // 元素異常狀態:玩家看不到這個機制存在的話,選屬性又退回只看傷害倍率了(見 statuses.ts)。
    rows.push(
      `<div class="tooltip-row">${iconMarkup(STATUS_ICONS[stats.statusKind], STATUS_UI_COLORS[stats.statusKind])} ${STATUS_NAMES[stats.statusKind]}(${stats.statusChancePercent}% 機率):${STATUS_DESCRIPTIONS[stats.statusKind]}</div>`,
    );
    rows.push(`<div class="tooltip-row">建造者:${escapeHtml(displayNameFor(tower.ownerId))}</div>`);
    const elementLabel = tower.secondElement
      ? `${ELEMENT_NAMES[tower.element]}×${ELEMENT_NAMES[tower.secondElement]}`
      : `${ELEMENT_NAMES[tower.element]}塔`;
    html = `<div class="tooltip-title">${escapeHtml(towerDisplayName(tower))}(${elementLabel})Lv.${tower.level}</div>${rows.join('')}`;
  } else if (info.kind === 'monster') {
    const m = state.monsters.find((x) => x.id === info.id);
    if (!m) {
      hideObjectTooltip();
      return;
    }
    const moveTypeLabel = m.moveType === 'air' ? '空中' : m.moveType === 'water' ? '水路' : '地面';
    const monsterRows = [
      `<div class="tooltip-row">血量 <b>${m.hp}</b> / ${m.maxHp}</div>`,
      `<div class="tooltip-row">移動:${moveTypeLabel}</div>`,
    ];
    if (m.shieldHp > 0) {
      monsterRows.push(`<div class="tooltip-row" style="color: var(--water)">護盾 <b>${m.shieldHp}</b> / ${m.maxShieldHp}</div>`);
    }
    const abilityIcon = ABILITY_ICONS[m.ability];
    if (m.ability !== 'none' && abilityIcon) {
      monsterRows.push(
        `<div class="tooltip-row" style="color: ${ABILITY_UI_COLORS[m.ability]}">${iconMarkup(abilityIcon)} ${ABILITY_NAMES[m.ability]}:${ABILITY_DESCRIPTIONS[m.ability]}</div>`,
      );
    }
    // 身上正在生效的異常狀態,讓玩家知道自己的塔真的有觸發效果(不然這個機制等於隱形的)。
    // 每個狀態各自配自己的圖示+顏色,跟地圖上那隻怪被染成的顏色對得起來。
    const activeStatuses: StatusKind[] = [];
    if (m.statusBurnTicks > 0) activeStatuses.push('burn');
    if (m.statusChillTicks > 0) activeStatuses.push('chill');
    if (m.statusEntangleTicks > 0) activeStatuses.push('entangle');
    if (m.statusSunderTicks > 0) activeStatuses.push('sunder');
    if (activeStatuses.length > 0) {
      const parts = activeStatuses
        .map((k) => `<span style="color: ${STATUS_UI_COLORS[k]}">${iconMarkup(STATUS_ICONS[k])} ${STATUS_NAMES[k]}</span>`)
        .join(' ');
      monsterRows.push(`<div class="tooltip-row">狀態:${parts}</div>`);
    }
    html = `<div class="tooltip-title">${ELEMENT_NAMES[m.element]}${m.isBoss ? ' · 首領' : ''}</div>${monsterRows.join('')}`;
  } else if (info.kind === 'trap') {
    const trap = state.traps.find((t) => t.id === info.id);
    if (!trap) {
      hideObjectTooltip();
      return;
    }
    const cost = trapUpgradeCost(trap);
    const upgradeRow = cost === null ? '已滿級' : `升級到 Lv.${trap.level + 1} 需要 ${cost} 金幣`;
    html = `<div class="tooltip-title">陷阱 Lv.${trap.level}</div><div class="tooltip-row">減速 <b>${TRAP_SLOW_PERCENT_BY_LEVEL[trap.level]}%</b></div><div class="tooltip-row">${upgradeRow}</div>`;
  } else if (info.kind === 'resourceBuilding') {
    const building = state.resourceBuildings.find((b) => b.id === info.id);
    if (!building) {
      hideObjectTooltip();
      return;
    }
    const intervalSec = Math.round((RESOURCE_BUILDING_INTERVAL_TICKS * currentTickRateMs) / 1000);
    html = `<div class="tooltip-title">資源建築</div><div class="tooltip-row">每 ${intervalSec}s +${RESOURCE_BUILDING_INCOME} 金幣</div><div class="tooltip-row">建造者:${escapeHtml(displayNameFor(building.ownerId))}</div>`;
  } else {
    const totem = state.runeTotems.find((r) => r.id === info.id);
    if (!totem) {
      hideObjectTooltip();
      return;
    }
    const specialized = totem.level >= MAX_RUNE_TOTEM_LEVEL && totem.upgradePath !== 'none';
    const effectRow = specialized
      ? totem.upgradePath === 'haste'
        ? `<div class="tooltip-row">疾風圖騰:範圍內塔 <b>+${RUNE_TOTEM_HASTE_PERCENT}%</b> 攻速</div>`
        : `<div class="tooltip-row">強化圖騰:範圍內塔 <b>+${RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED}%</b> 攻擊力</div>`
      : `<div class="tooltip-row">範圍內塔 <b>+${RUNE_TOTEM_DAMAGE_BONUS_PERCENT}%</b> 攻擊力</div>`;
    html = `<div class="tooltip-title">符文圖騰 Lv.${totem.level}</div>${effectRow}<div class="tooltip-row">範圍 <b>${(RUNE_TOTEM_RANGE_FP / FP_SCALE).toFixed(1)}</b> 格</div><div class="tooltip-row">建造者:${escapeHtml(displayNameFor(totem.ownerId))}</div>`;
  }

  objectTooltipEl.innerHTML = html;
  objectTooltipEl.classList.add('show');
  const canvasRect = document.getElementById('gameCanvas')?.getBoundingClientRect();
  const pageX = (canvasRect?.left ?? 0) + canvasX;
  const pageY = (canvasRect?.top ?? 0) + canvasY;
  const OFFSET_PX = 16;
  const width = objectTooltipEl.offsetWidth;
  const height = objectTooltipEl.offsetHeight;
  objectTooltipEl.style.left = `${Math.max(8, Math.min(pageX + OFFSET_PX, window.innerWidth - width - 8))}px`;
  objectTooltipEl.style.top = `${Math.max(8, Math.min(pageY + OFFSET_PX, window.innerHeight - height - 8))}px`;
}

const gameRenderer = createGameRenderer(
  'gameCanvas',
  (x, y, screenX, screenY) => {
    // GameScene 只有點到「已經有塔」的格子才會走 onTowerSelected 那條路;這裡收到的
    // 點擊可能是真的空地,也可能是已經有陷阱/資源建築的格子——先判斷清楚再決定要不要
    // 跳建造選單,不然玩家搞不清楚「這格不能蓋」到底是裝飾物(純視覺不影響蓋塔)擋住了,
    // 還是這格真的已經有陷阱/資源建築。
    if (!matchActive || (!room && !localEngine)) return;
    // 施放模式:這一下點擊是在選技能的施放位置,不是要蓋東西——直接送指令然後結束施放模式。
    // 放在最前面攔截,免得又跳出建造選單讓玩家困惑。
    if (armedSkill) {
      const skillId = armedSkill;
      setArmedSkill(null);
      submitAction({ kind: 'cast_skill', params: { skill: skillId, x, y } });
      showToast(`施放${SKILL_DEFS[skillId].name}`);
      return;
    }
    const myGold = latestState?.gold[myPlayerId()] ?? 0;
    const existingTrap = latestState?.traps.find((t) => t.x === x && t.y === y);
    const occupiedByResource = latestState?.resourceBuildings.some((r) => r.x === x && r.y === y);
    const existingTotem = latestState?.runeTotems.find((r) => r.x === x && r.y === y);
    // 已經有陷阱的格子改成跳「升級陷阱」選單(不分誰蓋的,誰都能出錢升級,跟塔升級同一套慣例),
    // 只有真的封頂了才單純跳提示,不會讓玩家搞不清楚這格到底能不能再做點什麼。
    if (existingTrap) {
      const cost = trapUpgradeCost(existingTrap);
      if (cost === null) {
        showToast('陷阱已經滿級了');
        return;
      }
      const nextLevel = existingTrap.level + 1;
      showFloatingBuildMenu(screenX, screenY, [
        {
          label: `升級陷阱(Lv.${existingTrap.level} → ${nextLevel})`,
          sublabel: `${cost} 金幣 · 減速 ${TRAP_SLOW_PERCENT_BY_LEVEL[existingTrap.level]}% → ${TRAP_SLOW_PERCENT_BY_LEVEL[nextLevel]}%`,
          disabled: myGold < cost,
          onChoose: () => {
            if ((latestState?.gold[myPlayerId()] ?? 0) < cost) {
              showToast(`金幣不足!升級陷阱需要 ${cost} 金幣`);
              return;
            }
            submitAction({ kind: 'upgrade_trap', params: { trapId: existingTrap.id } });
          },
        },
      ]);
      return;
    }
    if (occupiedByResource) {
      showToast('這格已經有資源建築了');
      return;
    }
    // 已經有符文圖騰的格子改成跳「升級圖騰」選單——圖騰只有 1→2 級這一次升級,而且這次
    // 升級一定要選分歧路線(跟塔升到分岐級同一套慣例),所以直接跳分歧選擇,不用先跳一個
    // 中間的「要不要升級」選單。
    if (existingTotem) {
      if (existingTotem.level >= MAX_RUNE_TOTEM_LEVEL) {
        showToast('符文圖騰已經滿級了');
        return;
      }
      showChoiceModal(`升級符文圖騰(選一條分歧路線)`, [
        {
          label: '強化圖騰',
          sublabel: `${RUNE_TOTEM_UPGRADE_COST} 金幣 · 攻擊力加成 +${RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED}%`,
          disabled: myGold < RUNE_TOTEM_UPGRADE_COST,
          onChoose: () => {
            if ((latestState?.gold[myPlayerId()] ?? 0) < RUNE_TOTEM_UPGRADE_COST) {
              showToast(`金幣不足!升級圖騰需要 ${RUNE_TOTEM_UPGRADE_COST} 金幣`);
              return;
            }
            submitAction({ kind: 'upgrade_rune_totem', params: { totemId: existingTotem.id, path: 'damage' } });
          },
        },
        {
          label: '疾風圖騰',
          sublabel: `${RUNE_TOTEM_UPGRADE_COST} 金幣 · 攻速加成 +${RUNE_TOTEM_HASTE_PERCENT}%(取代攻擊力加成)`,
          disabled: myGold < RUNE_TOTEM_UPGRADE_COST,
          onChoose: () => {
            if ((latestState?.gold[myPlayerId()] ?? 0) < RUNE_TOTEM_UPGRADE_COST) {
              showToast(`金幣不足!升級圖騰需要 ${RUNE_TOTEM_UPGRADE_COST} 金幣`);
              return;
            }
            submitAction({ kind: 'upgrade_rune_totem', params: { totemId: existingTotem.id, path: 'haste' } });
          },
        },
      ]);
      return;
    }
    const options: ChoiceOption[] = [];

    if (isOnPath(x, y)) {
      // 路徑格只能蓋陷阱(規則跟塔相反),不會有塔/資源建築可選。
      options.push({
        label: '陷阱',
        sublabel: `${TRAP_COST} 金幣${myGold < TRAP_COST ? '(金幣不足)' : ''}`,
        disabled: myGold < TRAP_COST,
        unaffordable: myGold < TRAP_COST,
        onChoose: () => {
          if ((latestState?.gold[myPlayerId()] ?? 0) < TRAP_COST) {
            showToast(`金幣不足!建造陷阱需要 ${TRAP_COST} 金幣`);
            return;
          }
          submitAction({ kind: 'build_trap', params: { x, y } });
        },
      });
    } else {
      // 非路徑格:固定列出玩家允許的全部屬性(WC3 TD 手塔風味)+ 資源建築 + 符文圖騰。
      // **雙屬性不在這裡**——2026-07-23 改成升級解鎖的選項(塔升到 DUAL_ELEMENT_MIN_LEVEL
      // 之後在塔面板加),不再是建造當下就能選的東西,見 towers.ts 的 DUAL_ELEMENT_MIN_LEVEL。
      for (const element of buildableTowerElements()) {
        const cost = TOWER_DEFS[element].cost;
        options.push({
          label: TOWER_CHARACTER_NAMES[element],
          sublabel: `${ELEMENT_NAMES[element]}塔 · ${cost} 金幣${myGold < cost ? '(金幣不足)' : ''}`,
          disabled: myGold < cost,
          unaffordable: myGold < cost,
          onChoose: () => {
            if ((latestState?.gold[myPlayerId()] ?? 0) < cost) {
              showToast(`金幣不足!建造${ELEMENT_NAMES[element]}塔需要 ${cost} 金幣`);
              return;
            }
            submitAction({ kind: 'build_tower', params: { x, y, element } });
          },
        });
      }
      options.push({
        label: '資源建築',
        sublabel: `${RESOURCE_BUILDING_COST} 金幣${myGold < RESOURCE_BUILDING_COST ? '(金幣不足)' : ''}`,
        disabled: myGold < RESOURCE_BUILDING_COST,
        unaffordable: myGold < RESOURCE_BUILDING_COST,
        onChoose: () => {
          if ((latestState?.gold[myPlayerId()] ?? 0) < RESOURCE_BUILDING_COST) {
            showToast(`金幣不足!建造資源建築需要 ${RESOURCE_BUILDING_COST} 金幣`);
            return;
          }
          submitAction({ kind: 'build_resource_building', params: { x, y } });
        },
      });
      options.push({
        label: '符文圖騰',
        sublabel: `${RUNE_TOTEM_COST} 金幣 · 範圍內全隊塔 +${RUNE_TOTEM_DAMAGE_BONUS_PERCENT}% 攻擊力${myGold < RUNE_TOTEM_COST ? '(金幣不足)' : ''}`,
        disabled: myGold < RUNE_TOTEM_COST,
        unaffordable: myGold < RUNE_TOTEM_COST,
        onChoose: () => {
          if ((latestState?.gold[myPlayerId()] ?? 0) < RUNE_TOTEM_COST) {
            showToast(`金幣不足!建造符文圖騰需要 ${RUNE_TOTEM_COST} 金幣`);
            return;
          }
          submitAction({ kind: 'build_rune_totem', params: { x, y } });
        },
      });
    }

    showFloatingBuildMenu(screenX, screenY, options);
  },
  (towerId) => {
    selectedTowerId = towerId;
    renderTowerPanel();
  },
  renderObjectTooltip,
);

skipWaveBtn.addEventListener('click', () => {
  submitAction({ kind: 'skip_to_next_wave', params: {} });
});

/** WC3 式選取面板:顯示選到的塔的即時數值,升級/賣出按鈕才會真的送出指令。 */
function renderTowerPanel(): void {
  const tower = selectedTowerId !== null ? latestState?.towers.find((t) => t.id === selectedTowerId) : undefined;
  towerPanelEl.hidden = !tower;
  // 塔面板會從畫面下緣升起來,蓋住固定在下緣的技能列——切一個 body class 讓 CSS 把
  // 技能列往上推(見 index.html 的 body.tower-panel-open 規則)。
  document.body.classList.toggle('tower-panel-open', !!tower);
  if (!tower) return;

  const stats = describeTower(tower, latestState?.towers ?? [], latestState?.runeTotems ?? []);
  const myGold = latestState?.gold[myPlayerId()] ?? 0;
  const elementLabel = tower.secondElement
    ? `${ELEMENT_NAMES[tower.element]}×${ELEMENT_NAMES[tower.secondElement]}`
    : `${ELEMENT_NAMES[tower.element]}塔`;
  towerPanelElementEl.textContent = `${towerDisplayName(tower)}(${elementLabel})`;
  towerPanelElementEl.className = `element-${tower.element}`;
  towerPanelOwnerEl.textContent = displayNameFor(tower.ownerId);
  towerPanelLevelEl.textContent = String(tower.level);
  towerPanelDamageEl.textContent = String(stats.damage);
  towerPanelRangeEl.textContent = (stats.rangeFp / FP_SCALE).toFixed(1);
  towerPanelCooldownEl.textContent = ((stats.cooldownTicks * currentTickRateMs) / 1000).toFixed(2);
  towerSellValueEl.textContent = String(stats.sellValue);
  towerPanelStrategySelect.value = tower.targetStrategy;

  // 分岐路線一旦選定(到 UPGRADE_PATH_LEVEL 之後)才顯示這行,選之前不用佔面板版面。
  towerPanelPathRowEl.hidden = tower.upgradePath === 'none';
  if (tower.upgradePath !== 'none') towerPanelPathEl.textContent = UPGRADE_PATH_NAMES[tower.upgradePath];
  towerPanelAdjacencyRowEl.hidden = !stats.adjacencyBonusActive;
  const totemActive = stats.totemDamageBonusPercent > 0 || stats.totemHastePercent > 0;
  towerPanelTotemRowEl.hidden = !totemActive;
  if (totemActive) {
    towerPanelTotemTextEl.textContent =
      stats.totemHastePercent > 0
        ? `圖騰加速中(+${stats.totemHastePercent}% 攻速)`
        : `圖騰增傷中(+${stats.totemDamageBonusPercent}% 攻擊力)`;
  }

  // 升級不分誰的塔,誰都能幫忙出錢升級;賣塔限本人,避免動到別人的投資。
  if (stats.upgradeCost === null) {
    towerUpgradeCostEl.textContent = '已滿級';
    towerUpgradeBtn.disabled = true;
    towerUpgradeBtn.classList.remove('cost-unaffordable');
  } else {
    const poor = myGold < stats.upgradeCost;
    towerUpgradeCostEl.textContent = String(stats.upgradeCost);
    towerUpgradeBtn.disabled = poor;
    // 「錢不夠」跟「不能做」要分得出來:單純 disabled 變淡的話,玩家看不出到底是
    // 條件不符還是只差錢。錢不夠就另外標紅(見 .cost-unaffordable)。
    towerUpgradeBtn.classList.toggle('cost-unaffordable', poor);
  }

  // 加第二屬性(2026-07-23 從建造選項改成升級解鎖,見 towers.ts 的 DUAL_ELEMENT_MIN_LEVEL):
  // **等級還不到就整顆不顯示**(不是顯示成 disabled)——面板上擺一顆永遠按不下去的按鈕
  // 只會讓玩家困惑「這什麼時候能按」,不如等真的能用了再出現。
  // 已經有第二屬性(定案不能改)、或玩家可用屬性不足 2 種(沒有組合可選)也一樣不顯示。
  const allowedElements = buildableTowerElements();
  const canAddSecond =
    !tower.secondElement && tower.level >= DUAL_ELEMENT_MIN_LEVEL && allowedElements.filter((e) => e !== tower.element).length > 0;
  towerSecondElementBtn.hidden = !canAddSecond;
  if (canAddSecond) {
    // 費用依「選哪個第二屬性」而定,但目前所有屬性造價相同,取最便宜的當面板顯示值即可;
    // 真正的扣款在 sim 端依實際選到的屬性算(見 secondElementCost)。
    const cheapest = Math.min(
      ...allowedElements.filter((e) => e !== tower.element).map((e) => secondElementCost(tower.element, e)),
    );
    const poor = myGold < cheapest;
    towerSecondElementCostEl.textContent = String(cheapest);
    towerSecondElementBtn.disabled = poor;
    towerSecondElementBtn.classList.toggle('cost-unaffordable', poor);
  }

  towerSellBtn.disabled = tower.ownerId !== myPlayerId();
}

/** 升到 UPGRADE_PATH_LEVEL(分岐級)一定要先選路線,選完才送出真正的升級指令;其他級數直接升級。 */
towerUpgradeBtn.addEventListener('click', () => {
  if (selectedTowerId === null) return;
  const towerId = selectedTowerId;
  const tower = latestState?.towers.find((t) => t.id === towerId);
  if (!tower) return;

  if (tower.level + 1 === UPGRADE_PATH_LEVEL) {
    const paths: UpgradePath[] = ['burst', 'splash'];
    showChoiceModal(
      '選擇升級路線(選定後無法更改)',
      paths.map((path) => ({
        label: UPGRADE_PATH_NAMES[path],
        sublabel: path === 'burst' ? '傷害比一般線性升級更高,沒有範圍效果' : '攻擊會波及主目標周圍的怪物,單體傷害不額外加成',
        onChoose: () => submitAction({ kind: 'upgrade_tower', params: { towerId, path } }),
      })),
    );
    return;
  }
  submitAction({ kind: 'upgrade_tower', params: { towerId } });
});

/**
 * 加第二屬性:跳選單讓玩家選要加哪一種(排除塔目前的主屬性,加同一種等於白花錢)。
 * 只列出這個玩家自己允許蓋的屬性——跟建塔同一條分工規則,不能靠這個繞過限制。
 */
towerSecondElementBtn.addEventListener('click', () => {
  if (selectedTowerId === null) return;
  const towerId = selectedTowerId;
  const tower = latestState?.towers.find((t) => t.id === towerId);
  if (!tower || tower.secondElement) return;

  const candidates = buildableTowerElements().filter((e) => e !== tower.element);
  showChoiceModal(
    '選擇第二屬性(選定後無法更改)',
    candidates.map((e2) => {
      const cost = secondElementCost(tower.element, e2);
      const poor = (latestState?.gold[myPlayerId()] ?? 0) < cost;
      return {
        label: `${ELEMENT_NAMES[tower.element]}×${ELEMENT_NAMES[e2]}`,
        sublabel: `${TOWER_CHARACTER_NAMES[e2]} · ${cost} 金幣${poor ? '(金幣不足)' : ''}`,
        disabled: poor,
        unaffordable: poor,
        onChoose: () => {
          if ((latestState?.gold[myPlayerId()] ?? 0) < cost) {
            showToast(`金幣不足!加第二屬性需要 ${cost} 金幣`);
            return;
          }
          submitAction({ kind: 'add_second_element', params: { towerId, secondElement: e2 } });
        },
      };
    }),
  );
});

towerSellBtn.addEventListener('click', () => {
  if (selectedTowerId === null) return;
  submitAction({ kind: 'sell_tower', params: { towerId: selectedTowerId } });
  gameRenderer.setSelectedTower(null);
  everSoldTowerThisMatch = true;
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

// 快捷鍵:數字鍵選浮動選單(建造選單或升級路線選單,哪個開著就選哪個)的第 N 個選項、
// Delete/Backspace 賣掉選中的塔、Esc 關掉開著的選單或取消選取。只在對局畫面生效,
// 且游標在任何輸入框裡(暱稱/房號等)時整個忽略,不然打字會被誤判成快捷鍵。
window.addEventListener('keydown', (ev) => {
  if (gameScreenEl.hidden) return;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') return;

  if (ev.key === 'Escape') {
    // 施放模式優先取消——玩家按 Esc 時最想放棄的通常是「剛點下去還沒選位置的技能」。
    if (armedSkill) {
      setArmedSkill(null);
      return;
    }
    if (floatingBuildMenuEl.classList.contains('show')) {
      hideFloatingBuildMenu();
      return;
    }
    if (choiceModalOverlayEl.classList.contains('show')) {
      hideChoiceModal();
      return;
    }
    gameRenderer.setSelectedTower(null);
    return;
  }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedTowerId !== null && !towerSellBtn.disabled) {
    submitAction({ kind: 'sell_tower', params: { towerId: selectedTowerId } });
    gameRenderer.setSelectedTower(null);
    everSoldTowerThisMatch = true;
    return;
  }
  const slot = Number(ev.key);
  if (!Number.isInteger(slot) || slot < 1 || slot > 8) return;
  const openMenu = floatingBuildMenuEl.classList.contains('show')
    ? floatingBuildMenuEl
    : choiceModalOverlayEl.classList.contains('show')
      ? choiceModalOptionsEl
      : null;
  openMenu?.querySelectorAll<HTMLButtonElement>('button.choice-option')[slot - 1]?.click();
});

/** 連線/對局事件記錄——原本畫在頁面上的 #log 區塊拿掉了(頁面不放除錯資訊),改進瀏覽器主控台。 */
function log(msg: string): void {
  console.log(`[wuxing-keep] ${msg}`);
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
  // 選單的標題/元素小圓點只在選單畫面才需要,遊戲畫面要滿版顯示,把這塊空間讓出來。
  document.body.classList.toggle('game-active', show);
  if (show) {
    backToMenuBtn.style.display = 'none';
    // #gameCanvas 從 display:none 切換成可見時不會觸發瀏覽器的 resize 事件,Phaser 的
    // Scale.RESIZE 模式量不到新的容器尺寸——等這一輪 layout 真的套用後手動叫它重新量測,
    // 不然畫布會卡在建立當下(容器還是 0x0)量到的舊尺寸,看起來完全沒有變滿版。
    requestAnimationFrame(() => gameRenderer.refreshSize());
  }
}

function setMode(mode: 'solo' | 'multi'): void {
  tabSoloEl.classList.toggle('active', mode === 'solo');
  tabMultiEl.classList.toggle('active', mode === 'multi');
  soloPanelEl.hidden = mode !== 'solo';
  multiPanelEl.hidden = mode !== 'multi';
}

tabSoloEl.addEventListener('click', () => setMode('solo'));
tabMultiEl.addEventListener('click', () => setMode('multi'));

/** 多人連線裡「建立房間」/「加入房間」兩塊表單一次只顯示一邊,不再兩個一起堆在畫面上。 */
function setMultiAction(action: 'host' | 'join'): void {
  subTabHostEl.classList.toggle('active', action === 'host');
  subTabJoinEl.classList.toggle('active', action === 'join');
  hostSectionEl.hidden = action !== 'host';
  joinSectionEl.hidden = action !== 'join';
}

subTabHostEl.addEventListener('click', () => setMultiAction('host'));
subTabJoinEl.addEventListener('click', () => setMultiAction('join'));

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

// HUD 精簡檢視模式:拿掉每個 hud-stat 的膠囊底色,只留浮動文字——偏好存 localStorage,
// 跟對局/房間無關,重開遊戲也記得上次選的模式。
const HUD_COMPACT_KEY = 'wuxing-keep:hudCompact';

function applyHudCompact(compact: boolean): void {
  document.body.classList.toggle('hud-compact', compact);
  hudCompactBtn.textContent = compact ? '詳細檢視' : '精簡檢視';
  localStorage.setItem(HUD_COMPACT_KEY, compact ? '1' : '0');
}

hudCompactBtn.addEventListener('click', () => {
  applyHudCompact(!document.body.classList.contains('hud-compact'));
});

applyHudCompact(localStorage.getItem(HUD_COMPACT_KEY) === '1');

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

// 「今日最佳」——地圖/波次本來就是完全固定的(seed 目前只用來當 checksum 起點,不影響任何生怪/數值),
// 所以不是真的「每天不同挑戰」,單純是每天重新歸零的個人紀錄,給每天想再挑戰一次的理由。
interface DailyBest {
  date: string;
  wave: number;
  cleared: boolean;
}

const DAILY_BEST_KEY = 'wuxing-keep:dailyBest';

/** 用台北時區算「今天」是幾號,避免跨時區/跨日界線算錯天。 */
function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function loadDailyBest(): DailyBest | null {
  try {
    const raw = localStorage.getItem(DAILY_BEST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const o = parsed as Partial<DailyBest>;
    if (typeof o.date === 'string' && typeof o.wave === 'number' && typeof o.cleared === 'boolean') {
      return { date: o.date, wave: o.wave, cleared: o.cleared };
    }
    return null;
  } catch {
    return null;
  }
}

/** 存的紀錄如果不是今天的,顯示上當作沒有紀錄(過期的舊紀錄留在 localStorage 裡沒關係,下次寫入會直接覆蓋)。 */
function renderDailyBest(record: DailyBest | null): void {
  const todays = record && record.date === todayDateString() ? record : null;
  dailyBestEl.textContent = !todays ? '今天還沒紀錄' : todays.cleared ? `全破!(第 ${todays.wave} 波)` : `第 ${todays.wave} 波`;
}

function saveDailyBestIfBetter(candidate: { wave: number; cleared: boolean }): void {
  const today = todayDateString();
  const current = loadDailyBest();
  const currentToday = current && current.date === today ? current : null;
  const better =
    !currentToday ||
    (candidate.cleared && !currentToday.cleared) ||
    (candidate.cleared === currentToday.cleared && candidate.wave > currentToday.wave);
  if (!better) return;
  const next: DailyBest = { date: today, wave: candidate.wave, cleared: candidate.cleared };
  localStorage.setItem(DAILY_BEST_KEY, JSON.stringify(next));
  renderDailyBest(next);
}

// 成就是「這台瀏覽器/這個人」的紀錄,單人/多人都算,一旦解鎖就不會再消失(只做 unlock,不做 lock 回去)。
// 多人連線時只反映「我自己」這一局的行為(有沒有賣塔、選了幾種屬性),不追蹤隊友做了什麼。
interface AchievementDef {
  id: string;
  label: string;
  hint: string;
}

const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'full-clear', label: '全破', hint: '清空所有波次獲勝' },
  { id: 'flawless', label: '無傷', hint: '全破且生命值全滿,一滴血都沒扣' },
  { id: 'no-sell', label: '節儉', hint: '全破且整場對局沒賣過任何一座塔' },
  { id: 'mono-element', label: '專精', hint: '只選 1 種屬性就全破' },
];

const ACHIEVEMENTS_KEY = 'wuxing-keep:achievements';

function loadAchievements(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Record<string, boolean> = {};
    for (const def of ACHIEVEMENTS) {
      if ((parsed as Record<string, unknown>)[def.id] === true) result[def.id] = true;
    }
    return result;
  } catch {
    return {};
  }
}

function renderAchievements(unlocked: Record<string, boolean>): void {
  achievementsEl.innerHTML = ACHIEVEMENTS.map(
    (def) =>
      `<span class="achievement-badge${unlocked[def.id] ? ' unlocked' : ''}" title="${escapeHtml(def.hint)}">${escapeHtml(def.label)}</span>`,
  ).join('');
}

// 本場對局的行為追蹤(不是模擬狀態,純前端記錄,對局開始時重置)。
let everSoldTowerThisMatch = false;
let myElementCountThisMatch = 5;

function evaluateAchievements(state: SimulationState): void {
  if (!state.victory) return;
  const unlocked = loadAchievements();
  let changed = false;
  const unlock = (id: string) => {
    if (!unlocked[id]) {
      unlocked[id] = true;
      changed = true;
    }
  };
  unlock('full-clear');
  // 個人生命模式下 state.lives 這個欄位是凍結不動的(見 simulation.ts 的說明,漏怪改扣
  // pathLives),不能直接拿來判斷「無傷」,要改比對每條路徑的生命是不是都還在開局的滿血狀態。
  const flawless = state.individualLivesMode
    ? state.pathLives.every((l) => l === Math.max(1, Math.floor(STARTING_LIVES / state.pathLives.length)))
    : state.lives === STARTING_LIVES;
  if (flawless) unlock('flawless');
  if (!everSoldTowerThisMatch) unlock('no-sell');
  if (myElementCountThisMatch === 1) unlock('mono-element');
  if (changed) {
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(unlocked));
    renderAchievements(unlocked);
  }
}

function renderLivesBar(lives: number): void {
  const ratio = Math.max(0, Math.min(1, lives / STARTING_LIVES));
  livesBarEl.style.width = `${ratio * 100}%`;
  livesBarEl.style.background = ratio > 0.5 ? '#3a9d3a' : ratio > 0.25 ? '#d4af37' : '#e05a2b';
  livesBarEl.parentElement?.classList.toggle('lives-critical', ratio <= 0.25);
}

/**
 * 生命 HUD:預設模式顯示團隊共用一條命條(`#teamLivesStat`);個人生命模式改顯示每條路徑
 * 各自一條命條(`#pathLivesStats`,動態產生,標出負責的玩家名字),兩者互斥顯示。
 */
function renderLivesHud(state: SimulationState): void {
  if (!state.individualLivesMode) {
    teamLivesStatEl.hidden = false;
    pathLivesStatsEl.hidden = true;
    livesEl.textContent = String(state.lives);
    renderLivesBar(state.lives);
    // 互助道具:緊急補命——只有生命快歸零時才顯示這顆按鈕,平常不佔位置也不會被誤按。
    emergencyHealBtn.hidden = state.lives > EMERGENCY_HEAL_THRESHOLD;
    return;
  }
  teamLivesStatEl.hidden = true;
  pathLivesStatsEl.hidden = false;
  const startingPerPath = Math.max(1, Math.floor(STARTING_LIVES / state.pathLives.length));
  pathLivesStatsEl.innerHTML = state.pathLives
    .map((lives, pathId) => {
      const owners = state.pathOwners[pathId] ?? [];
      const ownerLabel = owners.length > 0 ? owners.map((id) => displayNameFor(id)).join('、') : '無人負責';
      const ratio = Math.max(0, Math.min(1, lives / startingPerPath));
      const barColor = ratio > 0.5 ? '#3a9d3a' : ratio > 0.25 ? '#d4af37' : '#e05a2b';
      // 個人生命模式下每條路徑各自的補命按鈕(data-heal-path 事件代理,見下面的監聽器),
      // 同樣只有那條路徑快歸零時才顯示。
      const healBtn =
        lives <= EMERGENCY_HEAL_THRESHOLD
          ? `<button class="hud-action-btn" type="button" data-heal-path="${pathId}" title="花 ${EMERGENCY_HEAL_COST} 金幣補這條路徑幾條命"><svg class="icon"><use href="#icon-heart" /></svg> 補命</button>`
          : '';
      return `
        <div class="hud-stat">
          <svg class="icon" style="color: var(--fire)"><use href="#icon-heart" /></svg>
          路徑${pathId + 1}(${escapeHtml(ownerLabel)})
          <div class="lives-bar-outer ${ratio <= 0.25 ? 'lives-critical' : ''}"><div style="width:${ratio * 100}%; background:${barColor}"></div></div>
          ${lives}${healBtn}
        </div>
      `;
    })
    .join('');
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

/** 兩種模式都適用的「目前第幾波」,無限模式沒有上限、固定模式封頂在 WAVES.length。 */
function currentWaveNumberFor(state: SimulationState): number {
  // 「呼叫下一波」動的是 waveTickOffset,只有 effectiveWaveTick 會反映跳波後的結果,
  // 直接用 state.tick 算的話,按下按鈕後波數顯示會完全沒反應,要等真實時間追上才會變。
  const waveTick = effectiveWaveTick(state);
  return state.endlessMode ? currentWaveNumberEndless(waveTick) : currentWaveNumber(waveTick);
}

function renderWaveHud(state: SimulationState): void {
  const tick = effectiveWaveTick(state);
  waveNumberEl.textContent = String(currentWaveNumberFor(state));

  if (state.endlessMode) {
    // 無限模式永遠有下一波、永遠有預覽,不會是 null;沒有加碼波這個機制。
    skipWaveBtn.disabled = false;
    skipWaveBtn.title = '提早呼叫下一波(場上怪物不會被清掉,兩波會疊在一起)';
    const ticksLeft = ticksUntilNextWaveEndless(tick);
    nextWaveEl.textContent = `${Math.ceil((ticksLeft * currentTickRateMs) / 1000)}s`;
    const upcoming = upcomingWaveDefEndless(tick);
    const bossBadge = upcoming.isBoss
      ? `<svg class="icon" style="color: var(--accent)"><use href="#icon-crown" /></svg> `
      : '';
    // 三種首領造型給不同文字提示,玩家才知道接下來要準備的是耐力戰、群體戰還是反應戰。
    const bossLabel =
      upcoming.bossType === 'group' ? '首領小隊' : upcoming.bossType === 'swift' ? '迅捷首領' : '首領';
    nextWaveElementEl.innerHTML = `${bossBadge}${ELEMENT_NAMES[upcoming.element]}${upcoming.isBoss ? bossLabel : ''}`;
    bonusWaveEl.innerHTML = '';
    return;
  }

  const ticksLeft = ticksUntilNextWave(tick);
  // 已經是最後一波就沒有下一波可以跳,把按鈕停用+換提示文字,不會讓玩家點了沒反應搞不清楚
  // 是不是壞了(submitAction 那邊送出去本來就會被 simulation.ts 安全忽略,但完全沒有 UI
  // 回饋對玩家不友善)。
  skipWaveBtn.disabled = ticksLeft === null;
  skipWaveBtn.title = ticksLeft === null ? '已經是最後一波了' : '提早呼叫下一波(場上怪物不會被清掉,兩波會疊在一起)';
  nextWaveEl.textContent =
    ticksLeft === null ? '最後一波' : `${Math.ceil((ticksLeft * currentTickRateMs) / 1000)}s`;
  const upcoming = upcomingWaveDef(tick);
  if (!upcoming) {
    nextWaveElementEl.innerHTML = '—';
  } else {
    const bossBadge = upcoming.isBoss
      ? `<svg class="icon" style="color: var(--accent)"><use href="#icon-crown" /></svg> `
      : '';
    // 空中/水路怪出場前先提醒一下,玩家才知道要準備打得到這種移動類型的塔(見 canTargetMoveType)。
    const moveTypeBadge =
      upcoming.moveType === 'air'
        ? ` <svg class="icon" style="color: var(--muted)"><use href="#icon-wing" /></svg> 空中`
        : upcoming.moveType === 'water'
          ? ` <svg class="icon" style="color: var(--water)"><use href="#icon-wave" /></svg> 水路`
          : '';
    // 特殊能力也提前預告(跟空中/水路同樣的理由):玩家要先知道下一波會不會有治療兵/
    // 護盾兵才來得及調整佈陣,等怪出來了才發現「打不動」就太晚了。
    const ability = upcoming.ability ?? 'none';
    const abilityIcon = ABILITY_ICONS[ability];
    const abilityBadge =
      ability !== 'none' && abilityIcon
        ? ` ${iconMarkup(abilityIcon, ABILITY_UI_COLORS[ability])} ${ABILITY_NAMES[ability]}`
        : '';
    nextWaveElementEl.innerHTML = `${bossBadge}${ELEMENT_NAMES[upcoming.element]}${upcoming.isBoss ? '首領' : ''}${moveTypeBadge}${abilityBadge}`;
  }

  const bonus = activeBonusWaveInfo(tick);
  bonusWaveEl.innerHTML = bonus
    ? `<svg class="icon"><use href="#icon-star" /></svg> 加碼波!剩 ${Math.ceil((bonus.ticksLeft * currentTickRateMs) / 1000)}s 內清光可得 ${bonus.bonusGold} 金幣`
    : '';
}

/**
 * 進入/離開「等玩家點地圖選施放位置」的模式。除了記住是哪個技能,還要同步兩件視覺回饋:
 * 畫布游標變十字(body.skill-arming),以及該技能按鈕的高亮外框(.skill-arming)。
 * 傳 null 就是取消(再點一次同一顆、按 Esc、或真的放出去之後都會走到這裡)。
 */
function setArmedSkill(skillId: SkillId | null): void {
  armedSkill = skillId;
  document.body.classList.toggle('skill-arming', skillId !== null);
  renderSkillBar(latestState);
  renderSkillHint(null); // 帶 null:施放模式下 renderSkillHint 會自己顯示 armedSkill 的說明
}

/**
 * 技能列:依 skills.ts 的 SKILL_IDS 順序產生按鈕,冷卻中就 disabled 並顯示剩餘秒數。
 *
 * **刻意不用 innerHTML 整塊重畫**(記分板那種做法在這裡會出事):這個函式每個 tick(50ms)
 * 都會被呼叫一次來更新冷卻秒數,整塊換掉的話按鈕 DOM 每 50ms 就被銷毀重建一次——玩家按下去
 * 的瞬間如果剛好卡在重建的空檔,mousedown 跟 mouseup 會落在不同的元素上,瀏覽器就不會產生
 * click 事件,點了沒反應。記分板可以那樣寫是因為它不是每 tick 重畫。
 * 所以這裡改成:按鈕只建立一次(結構固定,SKILL_IDS 不會變),之後每 tick 只更新
 * 文字/disabled/class 這些屬性。
 */
function renderSkillBar(state: SimulationState | null): void {
  if (!state || !matchActive) {
    skillBarEl.replaceChildren();
    skillHintEl.innerHTML = '';
    return;
  }

  // 首次(或上一場對局結束時被清空過)才建立按鈕結構。
  if (skillBarEl.childElementCount !== SKILL_IDS.length) {
    skillBarEl.replaceChildren(
      ...SKILL_IDS.map((skillId) => {
        const def = SKILL_DEFS[skillId];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'skill-btn';
        btn.dataset.skill = skillId;
        btn.title = `${def.description}(冷卻 ${Math.round((def.cooldownTicks * currentTickRateMs) / 1000)} 秒)`;
        // 圖示 + 名稱 + 冷卻三層。圖示用 innerHTML 塞是安全的(symbolId 是寫死的常數,
        // 不是使用者輸入),名稱/冷卻仍走 textContent。
        const icon = document.createElement('span');
        icon.className = 'skill-btn-icon';
        icon.innerHTML = iconMarkup(SKILL_ICONS[skillId]);
        const name = document.createElement('span');
        name.className = 'skill-btn-name';
        name.textContent = def.name;
        const cd = document.createElement('span');
        cd.className = 'skill-btn-cd';
        btn.append(icon, name, cd);
        return btn;
      }),
    );
  }

  const myId = myPlayerId();
  for (const btn of Array.from(skillBarEl.children) as HTMLButtonElement[]) {
    const skillId = btn.dataset.skill as SkillId;
    const remaining = skillCooldownRemaining(state.skillCooldowns, myId, skillId);
    const armed = armedSkill === skillId;
    btn.disabled = remaining > 0;
    btn.classList.toggle('skill-arming', armed);
    const cdEl = btn.querySelector('.skill-btn-cd');
    if (cdEl) {
      const seconds = Math.ceil((remaining * currentTickRateMs) / 1000);
      cdEl.textContent = remaining > 0 ? `${seconds}s` : armed ? '點地圖' : '就緒';
    }
  }
}

skillBarEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.skill-btn');
  if (!btn || btn.disabled) return;
  const skillId = btn.dataset.skill as SkillId | undefined;
  if (!skillId) return;
  // 再點一次同一顆等於取消,不用特地去按 Esc。
  setArmedSkill(armedSkill === skillId ? null : skillId);
  if (armedSkill) showToast(`選擇${SKILL_DEFS[skillId].name}的施放位置(點地圖)`);
});

/**
 * 技能說明:顯示在技能列正上方。**冷卻中的技能也要看得到說明**——玩家常常就是在等冷卻的
 * 時候在想「這顆到底能幹嘛」,所以這裡不看 disabled 狀態。
 * 傳 null 就清掉(除非正在施放模式,那時候固定顯示該技能的說明)。
 */
function renderSkillHint(skillId: SkillId | null): void {
  const target = skillId ?? armedSkill;
  if (!target || !matchActive) {
    skillHintEl.innerHTML = '';
    return;
  }
  const def = SKILL_DEFS[target];
  const cooldownSec = Math.round((def.cooldownTicks * currentTickRateMs) / 1000);
  const rangeTiles = (def.rangeFp / FP_SCALE).toFixed(1);
  skillHintEl.innerHTML =
    `<b>${escapeHtml(def.name)}</b> — ${escapeHtml(def.description)}` +
    `<div class="skill-hint-meta">冷卻 ${cooldownSec} 秒 · 範圍 ${rangeTiles} 格 · 不花金幣${
      armedSkill === target ? ' · 點地圖決定施放位置' : ''
    }</div>`;
}

// 滑鼠移到技能按鈕上就顯示說明,移開就收起來(施放模式下維持顯示該技能的說明)。
skillBarEl.addEventListener('mouseover', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.skill-btn');
  renderSkillHint((btn?.dataset.skill as SkillId | undefined) ?? null);
});
skillBarEl.addEventListener('mouseleave', () => renderSkillHint(null));

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
    // 頁面上不放 tick/checksum 這種除錯資訊,但多人連線真的跑飛時還是需要比對兩邊的值——
    // 改成掛在 window 上,要查的時候自己在瀏覽器主控台打 window.__wuxingDebug 看,不會
    // 平常就佔一塊畫面。
    window.__wuxingDebug = { tick: state.tick, checksum: state.checksum };
    goldEl.textContent = String(state.gold[myPlayerId()] ?? 0);
    renderLivesHud(state);
    renderWaveHud(state);
    renderSkillBar(state);
    gameRenderer.renderState(state);
    renderTowerPanel();
    if (scoreboardOverlayEl.classList.contains('show')) renderScoreboard();
    if (state.gameOver) {
      // 無限模式沒有「破完」這回事,唯一的結局就是撐不住——顯示撐到第幾波當作這局的成績,
      // 不動最佳紀錄/今日最佳/成就系統(那套是繞著固定模式「全破」設計的,無限模式波次
      // 可以遠超過 8,兩種模式的數字混在一起比較沒有意義,先各自獨立,之後有需要再另外設計)。
      if (state.endlessMode) {
        showResult(`撐到第 ${currentWaveNumberFor(state)} 波,守備失敗`, 'defeat');
      } else {
        showResult('守備失敗(生命歸零)', 'defeat');
        saveBestRecordIfBetter({ wave: currentWaveNumber(state.tick), cleared: false });
        saveDailyBestIfBetter({ wave: currentWaveNumber(state.tick), cleared: false });
      }
      endLocalMatch();
      backToMenuBtn.style.display = 'inline-block';
    } else if (state.victory) {
      showResult('守備成功!全部波次清空', 'victory');
      saveBestRecordIfBetter({ wave: currentWaveNumber(state.tick), cleared: true });
      saveDailyBestIfBetter({ wave: currentWaveNumber(state.tick), cleared: true });
      evaluateAchievements(state);
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
    // 同單人模式:resetCamera() 依活躍地圖重畫靜態層,所以要先切好地圖再呼叫。
    setActiveMap(payload.mapId);
    gameRenderer.resetCamera();
    everSoldTowerThisMatch = false;
    if (!room) return;
    const me = payload.roster.find((p) => p.playerId === room?.getMyPlayerId());
    myElementCountThisMatch = me?.elements.length ?? 5;
    lastMatchConfig = {
      tickRateMs: payload.tickRateMs,
      inputDelayTicks: payload.inputDelayTicks,
      countdownMs: payload.countdownMs,
      difficultyPercent: payload.difficultyPercent,
      endlessMode: payload.endlessMode,
      individualLivesMode: payload.individualLivesMode,
      mapId: payload.mapId,
    };
    if (room.getRole() === 'host') {
      hostEngine = new HostLockstepEngine(room, lastMatchConfig, payload.seed, lockstepHandlers);
      hostEngine.start();
    } else {
      clientEngine = new ClientLockstepEngine(
        room,
        payload.seed,
        payload.difficultyPercent,
        payload.endlessMode,
        payload.individualLivesMode,
        payload.mapId,
        lockstepHandlers,
      );
    }
  },
  onRejected: (reason) => log(`加入被拒絕:${reason}`),
  onRoomEnded: (reasonText) => {
    log(`房間結束:${reasonText}`);
    if (matchActive) {
      // 走到這裡代表對局進行中真的沒救了(換房主也失敗,或這個事件本來就不是「跟房主斷線」
      // 這種可以嘗試換房主的情境,例如自己整個網路都斷了),遊戲畫面留著讓玩家按「回到選單」自己收尾。
      endMatchAfterUnrecoverableDisconnect();
    } else {
      // 還在 Lobby 階段就斷線(例如房主關掉分頁):直接退回設定表單重新來過
      resetToMultiSetup();
    }
  },
  onHostConnectionLost: () => {
    if (rehostInProgress || !room || !lastMatchConfig) return;
    rehostInProgress = true;
    showToast('房主斷線,正在嘗試自動換房主...');
    room
      .attemptRehost()
      .then((outcome) => {
        rehostInProgress = false;
        if (outcome === 'promoted') {
          // 換我方接手:場上塔/怪物/金幣是舊 ClientLockstepEngine 手上最新的那份(lockstep
          // 保證所有人模擬結果位元級相同,不用跟任何人要資料),原本待送出但還沒被舊房主排進
          // 已廣播 TICK 的指令會遺失——這是換房主接受的代價,見 lockstep.ts 的 LockstepSnapshot 註解。
          const resume = clientEngine?.exportForPromotion();
          clientEngine = null;
          hostEngine = new HostLockstepEngine(room!, lastMatchConfig!, 0, lockstepHandlers, resume);
          hostEngine.start();
          showToast('你已接手成為新房主,繼續遊戲!');
        } else if (outcome === 'reconnected') {
          // 還是客戶端,只是換了個房主連——場上進度不會馬上動,要等新房主回應 REJOIN 送來的
          // RESYNC(見 onResync)整份取代 state 才會真的接上,不能自己在這裡假設已經對齊了。
          showToast('已切換新房主,正在同步進度...');
        } else {
          endMatchAfterUnrecoverableDisconnect();
        }
      })
      .catch(() => {
        rehostInProgress = false;
        endMatchAfterUnrecoverableDisconnect();
      });
  },
  onRejoinRequest: (playerId) => {
    // 只有真的是房主(換房主接手後的新房主,或原本就是房主)且有跑起來的 HostLockstepEngine
    // 才有快照可給;playerId 目前用不到(REJOIN 已經在 room.ts 內部驗證過是已知玩家),
    // 保留參數是因為之後如果要做「不同玩家給不同資料」還有擴充空間。
    void playerId;
    return hostEngine?.getSnapshot() ?? null;
  },
  onResync: (tick, state) => {
    clientEngine?.applyResync(tick, state);
    showToast('已同步新房主的進度,繼續遊戲!');
  },
  onCommand: (cmd) => hostEngine?.enqueueRemoteCommand(cmd),
  onTick: (tick) => clientEngine?.receiveTick(tick),
};

/** 對局進行中真的沒辦法繼續(換房主失敗、或整個房間結束):停掉引擎,畫面留著讓玩家自己按「回到選單」。 */
function endMatchAfterUnrecoverableDisconnect(): void {
  matchActive = false;
  hostEngine?.stop();
  hostEngine = null;
  clientEngine = null;
  readyBtn.disabled = true;
  startBtn.disabled = true;
  backToMenuBtn.style.display = 'inline-block';
}

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
  // 一定要在 resetCamera() 之前切好地圖——resetCamera() 會依「目前的活躍地圖」重畫靜態層
  // (地板/路徑/裝飾物),這行漏掉的話畫面上會是上一張地圖的路徑,但實際模擬走的是新地圖。
  // (LocalEngine 建構子裡的 createInitialState() 也會呼叫一次,重複呼叫是安全的。)
  setActiveMap(soloMapSelect.value);
  gameRenderer.resetCamera();
  everSoldTowerThisMatch = false;
  myElementCountThisMatch = elements.length;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  localEngine = new LocalEngine(
    seed,
    BASE_MATCH_CONFIG.tickRateMs,
    lockstepHandlers,
    selectedDifficulty(soloPanelEl),
    elements,
    soloEndlessModeCheckbox.checked,
    soloMapSelect.value,
  );
  localEngine.start();
  log(`單人模式開始,seed=${seed}`);
});

backToMenuBtn.addEventListener('click', () => {
  showGameScreen(false);
  resetResultBanner();
  gameRenderer.setSelectedTower(null);
  // 離開對局就該把本地模擬停掉。實務上這顆按鈕只有在對局結束後才顯示(那時
  // onStateUpdated 已經呼叫過 endLocalMatch()),所以這行平常是 no-op——但「按鈕看不到」
  // 是很間接的保證,漏掉的話引擎會在回到選單後繼續在背景空轉,而且 soloBtn 會一直卡在
  // disabled 開不了下一局。明確停一次比依賴 UI 可見性可靠。
  endLocalMatch();
  matchActive = false;
  setArmedSkill(null); // 技能施放模式不該跨局殘留
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
  room?.startMatch({
    ...BASE_MATCH_CONFIG,
    difficultyPercent: Number(hostDifficultySelect.value) || 100,
    endlessMode: hostEndlessModeCheckbox.checked,
    individualLivesMode: hostIndividualLivesModeCheckbox.checked,
    mapId: hostMapSelect.value,
  });
});

renderBestRecord(loadBestRecord());
renderDailyBest(loadDailyBest());
renderAchievements(loadAchievements());
renderRecentRooms(loadRecentRooms());
log(`元素對照:${Object.entries(ELEMENT_NAMES).map(([k, v]) => `${k}=${v}`).join(' ')}`);
