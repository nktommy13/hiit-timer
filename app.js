/* =========================================================
   HIIT 计时器 —— 核心逻辑
   =========================================================

   最重要的一条设计：**所有计时都基于时间戳反算**。

   新手最容易写成这样：
       setInterval(() => { remaining -= 1; }, 1000);
   这在手机上必然不准 —— 只要切后台、锁屏或页面卡顿，
   浏览器就会把 setInterval 节流甚至暂停，计时随即跑偏。

   正确做法：开始时记下起点时间戳，每一帧用
       "已过去多久 = 现在的时间戳 − 起点时间戳"
   去反算应该处于哪个阶段。这样哪怕定时器被暂停 30 秒，
   恢复后时间立刻自动对齐。

   ---------- 为什么用 Date.now()，而不是 performance.now() ----------
   performance.now() 精度更高、不受系统对时影响，直觉上更适合计时。
   但 iOS 上它基于 mach_absolute_time，**设备休眠时会停止走动**：
   锁屏那段时间会凭空消失，计时器凭空变慢 —— 正好击穿整套设计的前提。
   训练计时器可以忍受 NTP 对时带来的几百毫秒跳动，绝不能忍受"停表"。
   ========================================================= */

/* ============================================================
   1. 配置
   ============================================================ */

/** 预设方案 */
const PRESETS = {
  tabata:  { prepare: 10, work: 20, rest: 10, rounds: 8,  sets: 1, setRest: 60 },
  classic: { prepare: 10, work: 30, rest: 15, rounds: 10, sets: 1, setRest: 60 },
  emom:    { prepare: 10, work: 40, rest: 20, rounds: 12, sets: 1, setRest: 60 },
};

/** 每个可调参数的元信息 —— 设置界面和数值校验都由它驱动 */
const FIELDS = [
  { key: 'prepare', label: '准备时间', unit: '秒', min: 0,   max: 60,  step: 5  },
  { key: 'work',    label: '工作',     unit: '秒', min: 5,   max: 300, step: 5  },
  { key: 'rest',    label: '休息',     unit: '秒', min: 0,   max: 300, step: 5  },
  { key: 'rounds',  label: '每组轮数', unit: '轮', min: 1,   max: 99,  step: 1  },
  { key: 'sets',    label: '组数',     unit: '组', min: 1,   max: 20,  step: 1  },
  { key: 'setRest', label: '组间休息', unit: '秒', min: 0,   max: 600, step: 15 },
];

/** 各阶段的显示信息 */
const PHASE_META = {
  prepare: { label: '准备',     color: '#a78bfa' },
  work:    { label: '工作',     color: '#34d399' },
  rest:    { label: '休息',     color: '#fbbf24' },
  setrest: { label: '组间休息', color: '#60a5fa' },
  done:    { label: '完成',     color: '#34d399' },
};

const STORAGE_KEY = 'hiit.config.v1';

/** 把任意输入夹到合法范围；非法值（NaN、空、乱码）回落到该字段的最小值 */
function clampField(field, raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return field.min;
  return Math.min(field.max, Math.max(field.min, n));
}

let config = loadConfig();

function loadConfig() {
  const merged = { ...PRESETS.tabata };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(merged, JSON.parse(raw));
  } catch (err) {
    console.warn('读取本地配置失败，改用默认值', err);
  }

  // 存档可能被手改坏，也可能来自参数范围不同的旧版本，必须逐项夹回合法范围。
  // 否则 rounds 变成 null 之类会让时间轴直接空掉，一按「开始」就跳到「完成」。
  FIELDS.forEach(field => {
    const ok = Number.isFinite(Math.round(Number(merged[field.key])));
    merged[field.key] = ok
      ? clampField(field, merged[field.key])
      : PRESETS.tabata[field.key];
  });

  return merged;
}

function persistConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('保存本地配置失败', err);
  }
}

/* ============================================================
   2. 声音 —— 用 Web Audio API 现场合成，不需要任何音频文件
   ============================================================ */

let audioCtx = null;

/**
 * iOS Safari 规定：音频必须由「用户手势」触发才能播放。
 * 所以这个函数只能在点击时调用，不能在页面加载时调用。
 */
function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;                       // 浏览器不支持就静默降级
    audioCtx = new Ctx();
  }

  ensureAudioAlive();

  // iOS 默认把 Web Audio 归到"环境音"通道，静音拨片一拨就彻底没声音。
  // 声明成 playback 通道才能穿透静音开关（Safari 17+）。
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch (err) { /* 忽略 */ }
  }
}

/**
 * 把被打断的音频上下文救回来。
 *
 * iOS 在锁屏、切后台、来电之后会把 AudioContext 置成 'suspended'，
 * 或置成 WebKit 专有的 'interrupted'。所以判断条件必须是
 * "不等于 running" —— 只判断 suspended 会漏掉 interrupted 这种情况，
 * 结果就是训练中途的提示音全部静音。
 */
function ensureAudioAlive() {
  if (audioCtx && audioCtx.state !== 'running') {
    audioCtx.resume().catch(() => {});
  }
}

/**
 * 播放提示音。
 * @param {number} freq      频率（Hz）—— 越高越"尖"，用来区分阶段
 * @param {number} duration  单个音长（秒）
 * @param {number} gain      音量 0~1
 * @param {number} count     连续响几声
 * @param {number} gap       每声之间的间隔（秒）
 */
function beep({ freq = 880, duration = 0.12, gain = 0.35, count = 1, gap = 0.18 } = {}) {
  if (!audioCtx) return;
  ensureAudioAlive();

  const t0 = audioCtx.currentTime;

  for (let i = 0; i < count; i++) {
    const start = t0 + i * gap;
    const end   = start + duration;

    const osc  = audioCtx.createOscillator();
    const vol  = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    // 加淡入淡出，否则会听到"啪"的爆音
    vol.gain.setValueAtTime(0, start);
    vol.gain.linearRampToValueAtTime(gain, start + 0.012);
    vol.gain.setValueAtTime(gain, end - 0.02);
    vol.gain.linearRampToValueAtTime(0, end);

    osc.connect(vol);
    vol.connect(audioCtx.destination);

    osc.start(start);
    osc.stop(end + 0.02);

    // 播完自动断开，防止长时间训练后节点堆积
    osc.onended = () => { try { vol.disconnect(); } catch (err) {} };
  }
}

/** 进入某个阶段时的提示音（音高不同 = 闭着眼也知道该干嘛） */
function announcePhase(phase) {
  switch (phase) {
    case 'prepare': beep({ freq: 784,  duration: 0.12, gain: 0.30 }); break;   // 中音
    case 'work':    beep({ freq: 1046, duration: 0.16, gain: 0.42 }); break;   // 高音 = 上！
    case 'rest':    beep({ freq: 587,  duration: 0.16, gain: 0.34 }); break;   // 低音 = 歇
    case 'setrest': beep({ freq: 523,  duration: 0.15, gain: 0.34, count: 2, gap: 0.22 }); break;
    case 'done':    beep({ freq: 1046, duration: 0.18, gain: 0.42, count: 3, gap: 0.24 }); break;
  }
}

/* ============================================================
   3. 把配置展开成一条完整的时间轴
   ============================================================ */

/**
 * 返回形如：
 *   [ {phase:'prepare', duration:10},
 *     {phase:'work', duration:20, set:1, round:1},
 *     {phase:'rest', duration:10, set:1, round:1}, ... ]
 *
 * 时长为 0 的阶段会被剔除（例如把「休息」设成 0 秒）。
 * 必须剔除，不能留着：0 长度的步骤 start === end，查找当前阶段时会被
 * 整段跳过，于是相位索引一次跳两格，被误判成"刚从后台恢复"，
 * 结果是每个工作段都响错提示音，提示条还会显示"下一个：休息 0 秒"。
 */
function buildSteps(cfg) {
  const steps = [];

  if (cfg.prepare > 0) {
    steps.push({ phase: 'prepare', duration: cfg.prepare });
  }

  for (let s = 1; s <= cfg.sets; s++) {
    for (let r = 1; r <= cfg.rounds; r++) {
      steps.push({ phase: 'work', duration: cfg.work, set: s, round: r });

      const lastRound = (r === cfg.rounds);
      const lastSet   = (s === cfg.sets);

      if (!lastRound) {
        steps.push({ phase: 'rest', duration: cfg.rest, set: s, round: r });
      } else if (!lastSet) {
        steps.push({ phase: 'setrest', duration: cfg.setRest, set: s, round: r });
      }
    }
  }

  return steps.filter(step => step.duration > 0);
}

/** 给每个 step 补上累计起止时间，便于按"总秒数"直接定位 */
function buildTimeline(steps) {
  let cursor = 0;
  return steps.map(step => {
    const item = { ...step, start: cursor, end: cursor + step.duration };
    cursor += step.duration;
    return item;
  });
}

/* ============================================================
   4. 计时引擎
   ============================================================ */

let timeline      = [];     // 当前时间轴
let totalDuration = 0;      // 总时长（秒）
let startStamp    = 0;      // 起点时间戳（毫秒，来自 Date.now()）
let running       = false;
let tickHandle    = null;
let currentIndex  = -1;     // 当前处在时间轴的第几段
let lastCountdown = null;   // 已经响过的倒计时秒数，避免同一秒重复响

const TICK_MS = 100;        // 每 100ms 刷新一次显示；计算与它无关，只影响刷新平滑度

/** 当前时间戳。包一层是为了让"计时基准"这件事只有一个出口，方便日后替换 */
function now() { return Date.now(); }

/** 取出"已过去 elapsed 秒时"应该处于哪一段 */
function stateAt(elapsed) {
  for (let i = 0; i < timeline.length; i++) {
    if (elapsed < timeline[i].end) {
      return { index: i, step: timeline[i], remaining: timeline[i].end - elapsed };
    }
  }
  return null;              // 全部走完
}

function prepareTimeline() {
  timeline      = buildTimeline(buildSteps(config));
  totalDuration = timeline.reduce((sum, s) => sum + s.duration, 0);
  currentIndex  = -1;
  lastCountdown = null;
}

function start() {
  unlockAudio();                                  // 必须在手势里解锁音频
  requestWakeLock();                              // 尽量让屏幕别熄灭

  prepareTimeline();
  startStamp = now();
  delete els.btnStart.dataset.elapsed;            // 清掉上一轮的残留进度
  running    = true;

  showScreen('timer');
  setControls('running');
  startTicking();
}

function pause() {
  if (!running) return;

  // 自己精确记录进度，而不是沿用上一次 tick 写下的值 ——
  // 那个值最多可能旧 100ms，恢复时会白白丢掉这段时间
  els.btnStart.dataset.elapsed = String((now() - startStamp) / 1000);

  running = false;
  stopTicking();
  releaseWakeLock();

  setControls('paused');
}

function resume() {
  unlockAudio();
  requestWakeLock();

  // 关键：把起点时间戳往回推，让"已过去的时间"接续原来的进度
  const elapsed = Number(els.btnStart.dataset.elapsed || 0);
  startStamp = now() - elapsed * 1000;
  running = true;

  setControls('running');
  startTicking();
}

function reset() {
  running = false;
  stopTicking();
  releaseWakeLock();

  prepareTimeline();
  delete els.btnStart.dataset.elapsed;            // 不留过期进度，避免被错误复用

  setControls('idle');
  renderIdle();
}

function startTicking() {
  stopTicking();
  tickHandle = setInterval(tick, TICK_MS);
  tick();                                        // 立刻画一帧，避免 100ms 白屏
}

function stopTicking() {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function tick() {
  if (!running) return;

  const elapsed = (now() - startStamp) / 1000;
  els.btnStart.dataset.elapsed = String(elapsed);   // 记下来，暂停后才能接续

  const state = stateAt(elapsed);

  if (!state) { finish(); return; }

  // ---- 阶段切换 ----
  if (state.index !== currentIndex) {
    const jumped = state.index - currentIndex;
    currentIndex = state.index;
    lastCountdown = null;

    if (jumped === 1) {
      announcePhase(state.step.phase);            // 正常推进：报阶段
    } else {
      // jumped > 1：刚从后台/锁屏回来，中间跳过了好几段。
      // 只响一声提醒"已经到这儿了"，不要补响一串音。
      // jumped < 0：时间被往回拨过（系统对时），重新报一次当前阶段即可。
      beep({ freq: 784, duration: 0.15, gain: 0.35 });

      // 如果落点正好在最后 3 秒，把倒计时标记预置好；否则这一帧会
      // 同时响"恢复音"和"倒数音"，听起来像卡了一下
      lastCountdown = Math.ceil(state.remaining);
    }
  }

  // ---- 最后 3 秒的倒数提示音 ----
  const secsLeft = Math.ceil(state.remaining);
  if (state.step.duration > 3 && secsLeft <= 3 && secsLeft >= 1 && secsLeft !== lastCountdown) {
    lastCountdown = secsLeft;
    beep({ freq: 660, duration: 0.07, gain: 0.25 });
  }

  render(state.step, state.remaining, elapsed);
}

function finish() {
  running = false;
  stopTicking();
  releaseWakeLock();

  phaseDone();
  announcePhase('done');      // 结束提示音：响三声
  setControls('done');
}

/* ============================================================
   5. 屏幕常亮（Wake Lock）
   ============================================================ */

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;           // 旧浏览器直接跳过

  try {
    const sentinel = await navigator.wakeLock.request('screen');

    // request() 是异步的。等待期间用户可能已经按了暂停或重置，
    // 这时必须立刻把刚拿到的锁还回去，否则屏幕会一直亮着。
    if (!running) {
      try { sentinel.release(); } catch (err) { /* 忽略 */ }
      return;
    }

    // 只认"自己这一把锁"的 release 事件。否则一把旧锁迟到的 release
    // 会把新锁的引用清掉，之后 releaseWakeLock() 就再也关不掉屏幕常亮了。
    sentinel.addEventListener('release', () => {
      if (wakeLock === sentinel) wakeLock = null;
    });
    wakeLock = sentinel;

  } catch (err) {
    console.warn('屏幕常亮申请失败（不影响计时）', err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (err) { /* 忽略 */ }
    wakeLock = null;
  }
}

/* ============================================================
   6. 渲染
   ============================================================ */

const els = {
  screenTimer:    document.getElementById('screen-timer'),
  screenSettings: document.getElementById('screen-settings'),
  phaseLabel:     document.getElementById('phase-label'),
  roundLabel:     document.getElementById('round-label'),
  countdown:      document.getElementById('countdown'),
  nextLabel:      document.getElementById('next-label'),
  progressFill:   document.getElementById('progress-fill'),
  btnStart:       document.getElementById('btn-start'),
  btnPause:       document.getElementById('btn-pause'),
  btnReset:       document.getElementById('btn-reset'),
  btnSettings:    document.getElementById('btn-settings'),
  settingsList:   document.getElementById('settings-list'),
  settingsTotal:  document.getElementById('settings-total'),
  btnSave:        document.getElementById('btn-save'),
  btnCancel:      document.getElementById('btn-cancel'),
};

function setAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
}

/**
 * 统一管理底部按钮的显隐和文案。
 *
 * 「设置」在训练中和暂停中都必须隐藏 —— 否则一个「保存」会把正在进行
 * 的时间轴整个换掉，而起点时间戳还指向旧时间轴，计时立刻错乱；
 * 暂停时进设置再返回，还会让界面显示"准备"、按钮却写着"继续"。
 *
 * @param {'idle'|'running'|'paused'|'done'} mode
 */
function setControls(mode) {
  const isRunning = (mode === 'running');
  const canEdit   = (mode === 'idle' || mode === 'done');

  els.btnStart.hidden    = isRunning;
  els.btnPause.hidden    = !isRunning;
  els.btnReset.hidden    = isRunning;      // 计时中藏起来，避免误触
  els.btnSettings.hidden = !canEdit;       // 见上方注释：训练中禁止改配置

  els.btnStart.textContent =
    mode === 'done'   ? '再来一次' :
    mode === 'paused' ? '继续'     :
                        '开始';

  // 把状态存在 dataset 里，点击时据此分支 —— 比比对按钮文字可靠
  els.btnStart.dataset.mode = mode;
}

function render(step, remaining, elapsed) {
  const meta = PHASE_META[step.phase];
  setAccent(meta.color);
  document.body.dataset.phase = step.phase;     // 驱动整屏背景色

  els.phaseLabel.textContent = meta.label;
  els.countdown.textContent  = Math.ceil(remaining);

  // 最后 3 秒加搏动效果，但别用在本来就极短的阶段上
  els.countdown.classList.toggle('urgent', remaining <= 3 && step.duration > 3);

  // 轮次 / 组次
  if (step.round != null) {
    let txt = `第 ${step.round} / ${config.rounds} 轮`;
    if (config.sets > 1) txt += `　·　第 ${Math.min(step.set, config.sets)} / ${config.sets} 组`;
    els.roundLabel.textContent = txt;
  } else {
    els.roundLabel.textContent = `共 ${Math.round(totalDuration / 60 * 10) / 10} 分钟`;
  }

  // "下一个是什么" —— 训练中不用回想
  const next = timeline[currentIndex + 1];
  els.nextLabel.textContent = next
    ? `下一个：${PHASE_META[next.phase].label} ${next.duration} 秒`
    : '最后一个阶段，坚持住';

  // 总进度条
  const pct = totalDuration > 0 ? (elapsed / totalDuration) * 100 : 0;
  els.progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

/** 未开始 / 重置后的静态显示 */
function renderIdle() {
  setAccent(PHASE_META.prepare.color);
  document.body.dataset.phase = 'prepare';

  els.phaseLabel.textContent = '准备';
  els.countdown.textContent  = Math.ceil(config.prepare || config.work);
  els.countdown.classList.remove('urgent');
  els.nextLabel.textContent  = '按「开始」进入训练';
  els.progressFill.style.width = '0%';

  const minutes = Math.round(totalDuration / 60 * 10) / 10;
  els.roundLabel.textContent = totalDuration > 0
    ? `共 ${minutes} 分钟 · ${config.rounds} 轮 × ${config.sets} 组`
    : '— / —';
}

function phaseDone() {
  setAccent(PHASE_META.done.color);
  document.body.dataset.phase = 'done';

  els.phaseLabel.textContent = '完成';
  els.countdown.textContent  = '🎉';
  els.countdown.classList.remove('urgent');
  els.roundLabel.textContent = '全部完成';
  els.nextLabel.textContent  = '干得漂亮';
  els.progressFill.style.width = '100%';
}

/* ============================================================
   7. 界面切换
   ============================================================ */

function showScreen(name) {
  const showTimer = (name === 'timer');
  els.screenTimer.hidden    = !showTimer;
  els.screenSettings.hidden = showTimer;
}

/* ============================================================
   8. 设置界面
   ============================================================ */

let draft = null;      // 编辑中的副本，点「保存」才写回 config

function openSettings() {
  if (running) return;                   // 双保险：训练中不允许进设置
  draft = { ...config };
  renderSettings();
  showScreen('settings');
}

function closeSettings() {
  draft = null;
  showScreen('timer');
}

function renderSettings() {
  els.settingsList.innerHTML = '';

  FIELDS.forEach(field => {
    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('div');
    label.className = 'field-label';
    // 这里的内容完全来自代码里写死的 FIELDS 常量，不含任何用户输入，无注入风险
    label.innerHTML = `${field.label}<span class="field-unit">${field.unit}</span>`;

    const stepper = document.createElement('div');
    stepper.className = 'stepper';

    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.setAttribute('aria-label', `减少${field.label}`);

    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.value = draft[field.key];
    input.dataset.key = field.key;

    const plus = document.createElement('button');
    plus.textContent = '+';
    plus.setAttribute('aria-label', `增加${field.label}`);

    const commit = () => {
      const v = clampField(field, input.value);   // NaN、空值、越界都会被夹住
      draft[field.key] = v;
      input.value = v;
      updateSettingsTotal();
    };

    minus.addEventListener('click', () => {
      input.value = clampField(field, draft[field.key] - field.step);
      commit();
    });
    plus.addEventListener('click', () => {
      input.value = clampField(field, draft[field.key] + field.step);
      commit();
    });
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);

    stepper.append(minus, input, plus);
    row.append(label, stepper);
    els.settingsList.append(row);
  });

  updateSettingsTotal();
}

function updateSettingsTotal() {
  const secs = buildSteps(draft).reduce((sum, s) => sum + s.duration, 0);
  els.settingsTotal.textContent = `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
}

/* ============================================================
   9. 事件绑定
   ============================================================ */

els.btnStart.addEventListener('click', () => {
  // 「开始」「继续」「再来一次」共用一个按钮，靠 setControls 写下的状态分支
  if (els.btnStart.dataset.mode === 'paused') resume();
  else start();
});

els.btnPause.addEventListener('click', pause);
els.btnReset.addEventListener('click', reset);
els.btnSettings.addEventListener('click', openSettings);
els.btnCancel.addEventListener('click', () => { closeSettings(); reset(); });

els.btnSave.addEventListener('click', () => {
  config = { ...draft };
  persistConfig();
  closeSettings();
  // 一律走 reset()，保证时间轴、按钮状态、进度条同时回到一致状态
  reset();
});

document.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    draft = { ...PRESETS[btn.dataset.preset] };
    renderSettings();
  });
});

// 切回前台时立刻重算一次，并把屏幕常亮和音频上下文都救回来。
// 系统在切后台时会自动释放 wake lock、挂起 AudioContext，回来必须重新申请。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    ensureAudioAlive();
    if (running) {
      requestWakeLock();
      tick();
    }
  }
});

// iOS 有时会拒绝在没有用户手势的情况下恢复音频上下文（锁屏、来电之后）。
// 补一个"任何一次触摸都顺便抢救一下"的兜底；passive 不影响滚动性能。
document.addEventListener('touchend', ensureAudioAlive, { passive: true });

/* ============================================================
   10. 启动
   ============================================================ */

prepareTimeline();
setControls('idle');
renderIdle();

// 注册 Service Worker，实现离线可用
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch(err => console.warn('Service Worker 注册失败（不影响使用）', err));
  });
}
