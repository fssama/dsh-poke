# dsh-poke

**DeepSeek Harness 插件：agent 每次向你提问时，自动把 DSH App 顶到前台。**

给 DSH 加一个 `user-questions/request` 钩子 —— 这是 Cordis 的 waterfall 事件，每次 agent 需要用户回答时触发。
钩子会立刻把 DSH App 切到前台，所以**你不会再错过 agent 的提问**；如果自动聚焦失败，补发一条 Android 通知兜底。

顺带守护一条「PC 看手机 DSH」的链路（凭据投递页进程 + adb 通道）。

## 它解决什么问题

在手机上跑 DSH，并让 agent 操作手机时，agent 必须把目标 App 切到前台 —— **DSH 自己就被挤到后台了**。
于是 agent 提出的问题你看不到，会话就卡在那里干等。

这个插件把「提问」和「把界面推到你眼前」绑在一起。

## 三个能力

| 能力 | 实现 |
| --- | --- |
| **提问自动前台** | 挂 `user-questions/request`（Cordis waterfall）→ `am start` 目标 Activity |
| **通知兜底** | 聚焦后等待 `focusWaitMs` 再查前台；没成功才发通知（可用 `notify: false` 关掉） |
| **链路守护** | 每 `tickMs` 检查凭据投递页端口，不在就拉起 |

两个模型可见工具：

- `poke_status` —— 体检整条链路（GUI 端口 / 凭据投递页 / adb 通道 / 认证栅栏 / 当前前台）
- `poke_focus` —— 立刻把 DSH App 切到前台

## 安装

```bash
dsh plugin --profile web add dsh-poke
```

或从本地目录：

```bash
dsh plugin --profile web add file:/path/to/dsh-poke
```

装完**重启一次 DSH**（新增 bundle 通常需要重组；若 profile 开了 HMR，可能直接热加载）。

## 配置

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: poke
  name: dsh-poke
  config:
    appId: com.dshmobile.probe
    activity: com.dshmobile.probe/.MainActivity
    adbScript: /sdcard/dsh/adb.sh      # 能跑 `am` / `cmd` / `dumpsys` 的脚本
    helperScript: /root/tunnel/serve-cookie.js
    helperLog: /root/tunnel/cookie.log
    killSwitch: /sdcard/dsh/poke.disabled
    guiPort: 3080
    helperPort: 3081
    tickMs: 45000
    focusWaitMs: 1300
    notify: true
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `appId` | `com.dshmobile.probe` | 要顶到前台的包名，也是聚焦成功与否的判据 |
| `activity` | `com.dshmobile.probe/.MainActivity` | `am start -n` 的目标 |
| `adbScript` | `/sdcard/dsh/adb.sh` | 以 `bash <脚本> shell <命令>` 调用；需要能拿到 shell（uid 2000）权限 |
| `adbScript` 之外的路径 | 见上 | 全部可换，方便移植 |
| `notify` | `true` | 关掉就完全不发通知 |
| `tickMs` | `45000` | 链路守护周期（毫秒） |

## 前置条件

这个插件本身不做提权，它只是**调用你已有的 shell 通道**。要让它工作，你需要：

1. 一个能从容器里执行 Android shell 命令的入口（配置里的 `adbScript`）。
   典型做法是手机开**无线调试**，容器侧的 adb 通过局域网连上去，封装成一个脚本。
2. 一个凭据投递页（`helperScript`）—— 只有你想在 PC 浏览器里看手机 DSH 时才需要。
   它给 PC 的浏览器签一个 DSH 会话 cookie；不需要可以把 `helperPort` 指向一个永远不存在的端口，
   守护会失败但不影响提问前台这条主链路。

> 本插件最初是为 Android 容器里的 DSH 写的，「手机 ↔ PC」那半套（cookie 投递、adb forward）
> 强依赖本机网络环境，**请按自己的环境改配置**。

## 安全性

两条硬约束，代码里都做了防护和测试：

1. **`apply()` 绝不抛异常。** 插件加载失败会让整个 profile 起不来，而 DSH 往往是唯一的对话通道。
   （已用「每个方法都抛错的恶意 ctx」验证。）
2. **提问钩子必须显式调用 `next()`。** `user-questions/request` 是 waterfall；
   不调 `next()` 会**截断提问链**，agent 永远等不到回答。代码里同步透传 `next`，
   并在 `next` 缺失时不崩。（已用桩测验证。）

一键静默：

```bash
touch /sdcard/dsh/poke.disabled   # 下次重启生效
```

## 已知限制

- 依赖 `am start` 能真的把目标 App 顶到前台。部分厂商 ROM 的后台冻结会让它失败 ——
  这正是「通知兜底」存在的原因。
- 只对 `web` profile 有意义（需要一个能看到 UI 的前台）。
- 硬编码的默认路径是 Android 容器的布局，移植请改配置。

## Contributors

| 贡献者 | 负责 |
| --- | --- |
| [chenyicheng233-dev](https://github.com/chenyicheng233-dev) | 需求定义、方案选型、全部设计决策与审阅 |
| DSH agent（`deepseek-flash`，运行于 DeepSeek Harness 容器内） | 实现、测试、文档 |

> **贡献者 ≠ 版权人。** 版权由 LICENSE 中记载的主体持有；本表只如实记录谁做了什么。
> 创作过程的说明见下方 Authoring。

## Authoring

本插件由用户与其设备上的 DSH agent 协作完成：

- **用户**定义需求、选择方案，并作出全部设计决策 —— 通道选型（adb shell 而非 root）、
  端口规划（避开 PC 上已有的 3080）、通知策略（仅聚焦失败时才发）、可配置化范围，
  以及是否开源与许可证选择。
- **agent** 负责实现、测试与文档。

两条关键安全约束都有测试覆盖：`apply()` 绝不抛异常（用「每个方法都抛错的恶意 ctx」验证），
以及 waterfall 事件必须透传 `next()`（否则提问链会被截断）——后者用桩测验证了同步透传与 `next` 缺失两种情形。


## License

MIT
