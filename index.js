// dsh-poke —— 把手机端 DSH 与你在 PC 上的浏览器联动起来。
//
// 做三件事：
//   1) agent 每次要向你提问时，自动把 DSH App 顶到前台；若没顶成功，补一条通知兜底。
//   2) 守住手机侧链路：adb 通道（adbScript 自带重连）+ 凭据投递页进程守护。
//   3) 提供 poke_status / poke_focus 两个工具。
//
// 两条必须遵守的设计约束：
//   - apply() 绝不抛异常。插件加载失败会让整个 profile 起不来，而 DSH 是唯一的对话通道。
//   - 提问钩子是 Cordis 的 waterfall 事件，必须显式调用 next()，否则提问链会被截断，
//     agent 会永远等不到回答。所有副作用一律吞掉异常。

import net from 'node:net'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'poke'
export const inject = ['tools']

const DEFAULTS = {
  appId: 'com.dshmobile.probe',
  activity: 'com.dshmobile.probe/.MainActivity',
  adbScript: '/sdcard/dsh/adb.sh',
  helperScript: '/root/tunnel/serve-cookie.js',
  helperLog: '/root/tunnel/cookie.log',
  killSwitch: '/sdcard/dsh/poke.disabled',
  legacyKillSwitch: '/sdcard/dsh/pclink.disabled',
  guiPort: 3080,
  helperPort: 3081,
  tickMs: 45000,
  focusWaitMs: 1300,
  notify: true,
}

/** 合并用户配置。config 同时兼容 apply(ctx, config) 与 ctx.config 两种来源。 */
function resolveConfig(ctx, config) {
  const fromCtx = (() => { try { return ctx && ctx.config } catch { return undefined } })()
  const merged = { ...DEFAULTS, ...(fromCtx && typeof fromCtx === 'object' ? fromCtx : {}), ...(config && typeof config === 'object' ? config : {}) }
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === 'number' && !Number.isFinite(merged[key])) merged[key] = DEFAULTS[key]
    if (typeof DEFAULTS[key] === 'string' && typeof merged[key] !== 'string') merged[key] = DEFAULTS[key]
  }
  return merged
}

const TAG = '[poke] '
function note(ctx, msg) {
  try { ctx.logger?.info?.(TAG + msg) } catch { /* 日志失败也不能影响启动 */ }
}

/** 跑一个子进程，永远 resolve，永不 reject。 */
function run(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        resolve({ ok: !error, out: String(stdout || ''), err: error ? String(stderr || error.message) : '' })
      })
    } catch (e) {
      resolve({ ok: false, out: '', err: String((e && e.message) || e) })
    }
  })
}

function portOpen(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    try {
      const sock = net.connect({ port, host })
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        try { sock.destroy() } catch { /* ignore */ }
        resolve(value)
      }
      sock.setTimeout(timeout)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    } catch {
      resolve(false)
    }
  })
}

function safeText(value, limit = 180) {
  return String(value).replace(/'/g, ' ').replace(/[\r\n]+/g, ' ').slice(0, limit)
}

/** 按配置造出一组动作，避免到处传 cfg。 */
function makeOps(cfg) {
  const adbShell = (cmd) => run('bash', [cfg.adbScript, 'shell', cmd])

  const ensureHelper = async () => {
    if (await portOpen(cfg.helperPort)) return true
    await run('bash', ['-c', `nohup node ${cfg.helperScript} >> ${cfg.helperLog} 2>&1 &`])
    await new Promise((r) => setTimeout(r, 1500))
    return portOpen(cfg.helperPort)
  }

  const focusApp = () => adbShell(`am start -n ${cfg.activity}`)

  const currentFocus = async () => {
    const r = await adbShell('dumpsys window')
    const m = r.out.match(/mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+)\//)
    return m ? m[1] : ''
  }

  const notify = (title, text) => {
    if (!cfg.notify) return Promise.resolve({ ok: true, out: '', err: '' })
    const t = safeText(title, 60)
    const b = safeText(text)
    return adbShell(`cmd notification post -S bigtext -t '${t}' dsh_poke '${b}'`)
  }

  const statusReport = async () => {
    const gui = await portOpen(cfg.guiPort)
    const helper = await portOpen(cfg.helperPort)
    const id = await adbShell('id')
    const fg = await currentFocus()
    let fence = 'GUI 不可达'
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.guiPort}/`)
      fence = res.status === 401 ? '✅ 正常（无 cookie 返回 401）' : `⚠️ HTTP ${res.status}`
    } catch { /* keep default */ }
    return [
      `GUI (${cfg.guiPort}): ${gui ? '✅ 在听' : '❌ 不可达'}`,
      `凭据投递页 (${cfg.helperPort}): ${helper ? '✅ 在听' : '❌ 未运行（会被守护自动拉起）'}`,
      `adb 通道: ${/uid=2000/.test(id.out) ? '✅ uid=2000(shell)' : '❌ ' + (id.err || id.out || '未知').slice(0, 90).trim()}`,
      `认证栅栏: ${fence}`,
      `当前前台: ${fg || '未知'}`,
    ].join('\n')
  }

  return { adbShell, ensureHelper, focusApp, currentFocus, notify, statusReport }
}

export function apply(ctx, config) {
  try {
    const cfg = resolveConfig(ctx, config)

    const hitKill = [cfg.killSwitch, cfg.legacyKillSwitch].find((p) => p && fs.existsSync(p))
    if (hitKill) {
      note(ctx, '检测到 ' + hitKill + '，插件保持静默')
      return
    }

    const ops = makeOps(cfg)

    // 1) 提问瞬间自动前台（waterfall：务必同步透传 next）
    try {
      ctx.on('user-questions/request', function onUserQuestion(_request, next) {
        void (async () => {
          try {
            await ops.ensureHelper()
            await ops.focusApp()
            await new Promise((r) => setTimeout(r, cfg.focusWaitMs))
            const fg = await ops.currentFocus()
            if (fg && !fg.includes(cfg.appId)) {
              await ops.notify('DSH 在等你回答', '自动聚焦未成功，请手动切回 DSH')
              note(ctx, `自动聚焦失败，当前前台 ${fg}`)
            }
          } catch (e) {
            try { await ops.notify('DSH 在等你回答', '自动聚焦出错，请手动切回 DSH') } catch { /* ignore */ }
            note(ctx, '提问钩子异常: ' + String((e && e.message) || e))
          }
        })()
        return typeof next === 'function' ? next() : undefined
      })
      note(ctx, `提问钩子已挂载（前台目标 ${cfg.appId}）`)
    } catch (e) {
      note(ctx, '挂载提问钩子失败: ' + String((e && e.message) || e))
    }

    // 2) 链路守护（Cordis effect 保证随 fiber 释放）
    try {
      const tick = () => { void ops.ensureHelper().catch(() => {}) }
      ctx.effect(() => {
        const timer = setInterval(tick, cfg.tickMs)
        tick()
        return () => clearInterval(timer)
      }, 'poke: 凭据投递页守护')
      note(ctx, `链路守护已启动（每 ${cfg.tickMs} ms）`)
    } catch (e) {
      note(ctx, '启动守护失败: ' + String((e && e.message) || e))
    }

    // 3) 工具
    try {
      const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
      ctx.tools.register(defineTool({
        name: 'poke_status',
        description: '体检「手机 DSH ↔ PC 浏览器」链路：GUI 端口、凭据投递页、adb 通道、认证栅栏、当前前台。链路出问题先跑这个。',
        parameters: {},
        output: textOutput,
        async execute() { return await ops.statusReport() },
      }))
      ctx.tools.register(defineTool({
        name: 'poke_focus',
        description: '立刻把手机上的 DSH App 切到前台（用户看不到对话时用）。',
        parameters: {},
        output: textOutput,
        async execute() {
          const r = await ops.focusApp()
          await new Promise((res) => setTimeout(res, cfg.focusWaitMs))
          const fg = await ops.currentFocus()
          return `聚焦指令: ${r.ok ? '已发送' : '失败 ' + r.err.slice(0, 80)}\n当前前台: ${fg || '未知'}`
        },
      }))
      note(ctx, '工具已注册: poke_status / poke_focus')
    } catch (e) {
      note(ctx, '注册工具失败: ' + String((e && e.message) || e))
    }
  } catch (e) {
    // 绝不让插件加载失败拖垮 profile
    try { console.error(TAG + 'apply 异常（已忽略）: ' + String((e && e.stack) || e)) } catch { /* ignore */ }
  }
}
