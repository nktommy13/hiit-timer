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
   恢复后时间立刻自动对齐，误差永远只有一次 tick 的量级。
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

/** 每个可调参数的元信息 —— 设置界面由它自动生成 */
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
  prepare: { label: '准备',   color: '#a78bfa' },
  work:    { label: '工作',   color: '#34d399' },
  rest:    { label: '休息',   color: '#fbbf24' },
  setrest: { label: '组间休息', color: '#60a5fa' },
  done:    { label: '完成',   color: '#34d399' },
};

const STORAGE_KEY = 'hiit.config.v1';

let config = loadConfig();

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // 与默认值合并，这样将来新增参数不会因为旧存档而缺失
      return { ...PRESETS.tabata, ...saved };
    }
  } catch (err) {
    console.warn('读取本地配置失败，改用默认值', err);
  }
  return { ...PRESETS.tabata };
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
 * 所以这个函数只能在点击「开始」时调用，不能在页面加载时调用。
 */
function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;                       // 浏览器不支持就静默降级
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
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
    osc.onended = () => { try { vol.disconnect(); } catch (e) {} };
  }
}

/** 进入某个阶段时的提示音（音高不同 = 闭着眼也知道该干嘛） */
function announcePhase(phase) {
  switch (phase) {
    case 'prepare': beep({ freq: 784, duration: 0.12, gain: 0.30 }); break;             // 中音
    case 'work':    beep({ freq: 1046, duration: 0.16, gain: 0.42 }); break;            // 高音 = 上！
    case 'rest':    beep({ freq: 587, duration: 0.16, gain: 0.34 }); break;             // 低音 = 歇
    case 'setrest': beep({ freq: 523, duration: 0.15, gain: 0.34, count: 2, gap: 0.22 }); break;
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

  return steps;
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
let startStamp    = 0;      // performance.now() 起点
let running       = false;
let tickHandle    = null;
let currentIndex  = -1;     // 当前处在时间轴的第几段
let lastCountdown = null;   // 已经响过的倒计时秒数，避免同一秒重复响

const TICK_MS = 100;        // 每 100ms 刷新一次显示；计算与它无关，只影响刷新平滑度

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
  startStamp = performance.now();
  running    = true;

  showScreen('timer');
  els.btnStart.hidden = true;
  els.btnPause.hidden = false;
  els.btnReset.hidden = true;                     // 计时中先藏起来，避免误触

  startTicking();
}

function pause() {
  if (!running) return;
  running = false;
  stopTicking();
  releaseWakeLock();

  els.btnPause.hidden = true;
  els.btnStart.hidden = false;
  els.btnStart.textContent = '继续';
  els.btnReset.hidden = false;
}

function resume() {
  unlockAudio();
  requestWakeLock();

  // 关键：把起点时间戳往回推，让"已过去的时间"接续原来的进度
  const elapsed = Number(els.btnStart.dataset.elapsed || 0);
  startStamp = performance.now() - elapsed * 1000;
  running = true;

  els.btnStart.hidden = true;
  els.btnPause.hidden = false;
  els.btnReset.hidden = true;

  startTicking();
}

function reset() {
  running = false;
  stopTicking();
  releaseWakeLock();

  prepareTimeline();

  els.btnStart.hidden = false;
  els.btnStart.textContent = '开始';
  els.btnPause.hidden = true;
  els.btnReset.hidden = false;

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

  const elapsed = (performance.now() - startStamp) / 1000;
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
    } else if (jumped > 1) {
      // 说明刚才被系统挂起了（切后台/锁屏），中间跳过了好几段。
      // 只响一声提醒"已经到这儿了"，不要补响一串音。
      beep({ freq: 784, duration: 0.15, gain: 0.35 });
    }

    if (state.step.phase === 'done') announcePhase('done');
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

  els.btnStart.hidden = false;
  els.btnStart.textContent = '再来一次';
  els.btnPause.hidden = true;
  els.btnReset.hidden = false;
}

/* ============================================================
   5. 屏幕常亮（Wake Lock）
   ============================================================ */

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;           // 旧浏览器直接跳过
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('屏幕常亮申请失败（不影响计时）', err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (e) {}
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

function render(step, remaining, elapsed) {
  const meta = PHASE_META[step.phase];
  setAccent(meta.color);

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

  document.body.dataset.phase = showTimer ? (PHASE_META.prepare && 'prepare') : 'settings';
}

/* ============================================================
   8. 设置界面
   ============================================================ */

let draft = null;      // 编辑中的副本，点「保存」才写回 config

function openSettings() {
  draft = { ...config };
  renderSettings();
  showScreen('settings');
}

function closeSettings() {
  draft = null;
  showScreen('timer');
  renderIdle();
}

function renderSettings() {
  els.settingsList.innerHTML = '';

  FIELDS.forEach(field => {
    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('div');
    label.className = 'field-label';
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

    const clamp = v => Math.min(field.max, Math.max(field.min, v));

    const commit = () => {
      const v = clamp(Math.round(Number(input.value) || 0));
      draft[field.key] = v;
      input.value = v;
      updateSettingsTotal();
    };

    minus.addEventListener('click', () => { input.value = clamp(draft[field.key] - field.step); commit(); });
    plus .addEventListener('click', () => { input.value = clamp(draft[field.key] + field.step); commit(); });
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
  // 「开始」和「继续」共用一个按钮，用文字区分
  if (els.btnStart.textContent === '继续') resume();
  else start();
});

els.btnPause.addEventListener('click', pause);
els.btnReset.addEventListener('click', reset);
els.btnSettings.addEventListener('click', openSettings);
els.btnCancel.addEventListener('click', closeSettings);

els.btnSave.addEventListener('click', () => {
  config = { ...draft };
  persistConfig();
  closeSettings();
  prepareTimeline();
  renderIdle();
});

document.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    draft = { ...PRESETS[btn.dataset.preset] };
    renderSettings();
  });
});

// 切回前台时立刻重算一次，并把屏幕常亮重新申请上
// （系统在切后台时会自动释放 wake lock，回来必须重新申请）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (running) {
      requestWakeLock();
      tick();
    }
  }
});

// 防止 iPhone 双击缩放干扰连续点击
document.addEventListener('gesturestart', e => e.preventDefault());

/* ============================================================
   10. 启动
   ============================================================ */

prepareTimeline();
renderIdle();

// 注册 Service Worker，实现离线可用
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch(err => console.warn('Service Worker 注册失败（不影响使用）', err));
  });
}
