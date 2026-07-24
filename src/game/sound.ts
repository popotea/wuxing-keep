// 程序合成音效(2026-07-24 加的):全部用 WebAudio 振盪器即時合成,不需要任何音檔資產——
// 跟專案「免伺服器、免註冊」的極簡精神一致,也不用煩惱音檔授權跟載入流量。
// 純顯示層(跟 GameScene 同一層),模擬層完全不知道音效存在,不影響決定性。
//
// 瀏覽器的自動播放政策:AudioContext 要在使用者手勢之後才能真的出聲——main.ts 在第一次
// pointerdown 時呼叫 unlock()(建立/恢復 context),在那之前所有播放呼叫都是安全的 no-op。

const MUTED_STORAGE_KEY = 'wuxing-keep:muted';

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let muted = false;

try {
  muted = localStorage.getItem(MUTED_STORAGE_KEY) === '1';
} catch {
  // localStorage 不可用(隱私模式等)就用預設值,音效不是關鍵功能
}

/** 第一次使用者手勢時呼叫(main.ts 綁 pointerdown once)——之後播放才真的出聲。 */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.22; // 整體音量壓低,遊戲音效是陪襯不是主角
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null; // 環境不支援 WebAudio 就整個靜音,不影響遊戲
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTED_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 存不了偏好就算了
  }
}

interface ToneOptions {
  type?: OscillatorType;
  /** 相對音量(最後還會乘 masterGain)。 */
  gain?: number;
  /** 播放期間頻率滑到這個值(掃頻),不給就固定頻率。 */
  slideTo?: number;
  /** 延遲多久才開始(秒),組和弦/琶音用。 */
  delay?: number;
}

/** 一顆包絡控制的振盪器音:快速起音、指數衰減,durMs 結束時自動銷毀。 */
function tone(freq: number, durMs: number, opts: ToneOptions = {}): void {
  if (muted || !ctx || !masterGain || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const dur = durMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + dur);
  }
  const peak = opts.gain ?? 0.5;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 塔攻擊聲的節流:combatEvents 每 tick 都可能有,全放會變機關槍噪音。 */
let lastShotAt = 0;

export const sfx = {
  /** 塔攻擊(節流到最多每 90ms 一次,頻率帶一點隨機讓連續射擊不死板——純 UI,不影響模擬)。 */
  shot(): void {
    const now = performance.now();
    if (now - lastShotAt < 90) return;
    lastShotAt = now;
    tone(700 + Math.random() * 200, 60, { type: 'triangle', gain: 0.12, slideTo: 220 });
  },
  /** 擊殺(小小的金幣聲)。 */
  kill(): void {
    tone(880, 70, { type: 'sine', gain: 0.2 });
    tone(1320, 90, { type: 'sine', gain: 0.16, delay: 0.05 });
  },
  /** 建造完成(低沉的落地感)。 */
  build(): void {
    tone(180, 90, { type: 'square', gain: 0.22 });
    tone(90, 150, { type: 'sine', gain: 0.3, delay: 0.02 });
  },
  /** 賣出/拆除(下行雙音)。 */
  sell(): void {
    tone(520, 80, { type: 'triangle', gain: 0.22 });
    tone(340, 120, { type: 'triangle', gain: 0.2, delay: 0.07 });
  },
  /** 新一波開始(上行號角感)。 */
  wave(): void {
    tone(262, 160, { type: 'sawtooth', gain: 0.14 });
    tone(330, 160, { type: 'sawtooth', gain: 0.14, delay: 0.12 });
    tone(392, 260, { type: 'sawtooth', gain: 0.16, delay: 0.24 });
  },
  /** 施放技能(上掃頻的「咻」)。 */
  skill(): void {
    tone(220, 260, { type: 'sawtooth', gain: 0.18, slideTo: 880 });
  },
  /** 漏怪扣血(下墜的警示音)。 */
  leak(): void {
    tone(330, 220, { type: 'square', gain: 0.22, slideTo: 110 });
  },
  /** 送出/收到金幣禮物。 */
  gift(): void {
    tone(660, 80, { type: 'sine', gain: 0.16 });
    tone(990, 110, { type: 'sine', gain: 0.14, delay: 0.06 });
  },
  /** 個人出局(低沉雙響)。 */
  eliminated(): void {
    tone(160, 240, { type: 'square', gain: 0.24 });
    tone(120, 380, { type: 'square', gain: 0.24, delay: 0.22 });
  },
  /** 勝利(大調琶音上行)。 */
  victory(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => tone(f, 280, { type: 'triangle', gain: 0.2, delay: i * 0.14 }));
  },
  /** 失敗/對局中止(下行三音)。 */
  defeat(): void {
    const notes = [392, 311, 233];
    notes.forEach((f, i) => tone(f, 340, { type: 'triangle', gain: 0.2, delay: i * 0.18 }));
  },
};
