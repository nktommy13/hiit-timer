# HIIT 计时器

一个用于高强度间歇训练（HIIT）的极简计时器，纯前端 PWA，无需构建步骤。

**在线使用：** https://nktommy13.github.io/hiit-timer/

## 功能

- 准备 → (工作 → 休息) × 轮数 → 组间休息 的标准 HIIT 结构
- 可调参数：准备时间、工作时长、休息时长、每组轮数、组数、组间休息
- 三组内置预设：Tabata (20/10)、30/15、40/20
- 音频提示：工作段高音、休息段低音、倒数 3 秒滴答、结束三连音
- 屏幕常亮（Wake Lock），训练中不会黑屏
- 离线可用（Service Worker）
- 配置存本地，下次打开还在

## 在 iPhone 上安装

1. Safari 打开上面的链接（**必须是 Safari**，Chrome 不支持添加到主屏幕）
2. 点分享按钮 → 「添加到主屏幕」
3. 从主屏幕启动，全屏运行，和原生 App 一样

## 核心设计

### 为什么用时间戳反算，而不是逐秒递减

新手写法通常是：

```js
setInterval(() => { remaining -= 1; }, 1000);
```

这在手机上必然不准。只要切后台、锁屏或页面卡顿，浏览器就会把
`setInterval` 节流甚至暂停，计时随即跑偏。

正确做法是记下起点时间戳，每一帧反算：

```js
const elapsed = (now() - startStamp) / 1000;
const state = stateAt(elapsed);   // 按总秒数直接定位到当前阶段
```

这样定时器被暂停多久都不影响 —— 恢复后时间立刻自动对齐。

### 为什么是 `Date.now()` 而不是 `performance.now()`

`performance.now()` 精度更高、且不受系统对时影响，直觉上更适合计时。
但 iOS 上它基于 `mach_absolute_time`，**设备休眠时会停止走动**：
锁屏那段时间会凭空消失，计时器凭空变慢。

训练计时器可以忍受 NTP 对时带来的几百毫秒跳动，绝不能忍受「停表」。

### 其他 iOS 相关的坑

- **音频必须由用户手势解锁** —— 页面加载时初始化 `AudioContext` 是没有声音的
- **`AudioContext` 会被置成 `interrupted`** —— 锁屏/来电后，判断条件必须是
  `state !== 'running'`，只检查 `suspended` 会漏掉
- **静音拨片会屏蔽 Web Audio** —— 需要声明 `navigator.audioSession.type = 'playback'`
- **唤醒锁在切后台时自动释放** —— 回到前台必须重新申请
- **`touch-action: manipulation`** 才能消除双击缩放（`gesturestart` 拦不住双击）

## 目录结构

```
index.html       界面骨架（含 iOS 全屏 meta）
style.css        深色主题、超大字号、刘海适配
app.js           全部逻辑（约 660 行，注释详细）
sw.js            Service Worker → 离线可用
manifest.json    PWA 配置
make_icons.py    用代码生成 App 图标（需要 Pillow）
icons/           180 / 192 / 512 三种尺寸
```

## 本地开发

```bash
python3 -m http.server 8791
# 打开 http://127.0.0.1:8791
```

重新生成图标：

```bash
pip install pillow
python3 make_icons.py
```

> Service Worker 采用「网络优先」策略，改完代码直接刷新就能看到最新版。
> 若某次刷新拿到的是旧文件，硬刷新一次即可。

## 已知限制

- 锁屏后计时是否精确，依赖 `Date.now()` 这一假设，需在真机验证
- 穿透静音拨片需要 Safari 17+
- 主屏幕 Web App 的唤醒锁支持需要 iOS 18.4+
