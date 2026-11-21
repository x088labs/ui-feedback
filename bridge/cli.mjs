#!/usr/bin/env node
// tl-ui-feedback: start | poll | reply | status | serve | install | uninstall | stop | token | url
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureServer, poll, reply, status, formatItem, nextStep, formatUnanswered, baseUrl, permissionHook } from './client.mjs'
import { stateDir, loadOrCreateToken } from './server.mjs'
import { startServe, stopServe, listServes, runDevCommand, probe } from './serve.mjs'
import * as inst from './install.mjs'
import { L } from './i18n.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Đăng ký MCP ở phạm vi user của Claude Code.
function installMcp() {
  const mcp = path.join(ROOT, 'mcp', 'server.mjs')
  spawnSync('claude mcp remove --scope user ui-feedback', { shell: true, stdio: 'ignore' }) // dọn tên cũ
  spawnSync('claude mcp remove --scope user tl-ui-feedback', { shell: true, stdio: 'ignore' })
  // shell:true không tự bọc ngoặc: dùng `node` qua PATH và bọc đường dẫn script (có thể chứa khoảng trắng).
  const r = spawnSync(`claude mcp add --scope user tl-ui-feedback -- node "${mcp}"`, { shell: true, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(L('claude mcp add thất bại; chạy tay: ', 'claude mcp add failed; run it yourself: ') + 'claude mcp add --scope user tl-ui-feedback -- node "' + mcp + '"')
}

function uninstallMcp() {
  spawnSync('claude mcp remove --scope user ui-feedback', { shell: true, stdio: 'ignore' }) // tên cũ
  const r = spawnSync('claude mcp remove --scope user tl-ui-feedback', { shell: true, stdio: 'ignore' })
  return r.status === 0
}
function installShim(addPath) {
  const bin = inst.defaultBinDir()
  inst.installShim({ root: ROOT, binDir: bin })
  console.log(L('lệnh `tl-ui-feedback` đã ghi vào:', '`tl-ui-feedback` command written to:'), bin)
  if (inst.onPath(bin)) return console.log(L('Thư mục này đã nằm trong PATH.', 'This folder is already on PATH.'))
  if (addPath) {
    const r = inst.addToUserPath(bin)
    if (!r.unsupported) return console.log(r.changed ? L('Đã thêm vào PATH người dùng. Mở terminal MỚI để dùng lệnh.', 'Added to your user PATH. Open a NEW terminal to use the command.') : L('PATH người dùng đã có thư mục này; mở terminal MỚI.', 'Your user PATH already has this folder; open a NEW terminal.'))
  }
  console.log(inst.pathHint(bin) + (addPath ? '' : L('\n(hoặc chạy lại với --path để tự thêm trên Windows)', '\n(or rerun with --path to add it automatically on Windows)')))
}

const [cmd, ...rest] = process.argv.slice(2)

// Hook xin quyền: phải im lặng và thoát 0 khi có bất kỳ lỗi nào để agent hỏi người dùng như thường.
if (cmd === 'permission-hook') {
  try {
    let text = ''
    for await (const ch of process.stdin) text += ch
    const out = await permissionHook(JSON.parse(text || '{}'))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {}
  process.exit(0)
}

const flag = (n) => {
  const i = rest.indexOf('--' + n)
  return i >= 0 ? rest[i + 1] : undefined
}
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))

const HELP = () => L(`tl-ui-feedback <lệnh>
  start                     chạy bridge ở nền (tự chạy khi cần)
  poll [--origin URL | --any] [--timeout-ms N] [--json]   chờ phản hồi (có serve đang chạy thì bắt buộc --origin)
  reply "<văn bản>" | reply - [--id fb_..] [--origin URL]  trả lời, hiện trên trang (không id thì nên truyền --origin); "-" đọc từ stdin để có nhiều dòng
  status                    số phản hồi đang chờ / agent đang nghe
  serve [cổng] <thư-mục|file.html|http://localhost:PORT> [--spa] [--no-open] [--allow-remote-upstream]
                            phục vụ site (hoặc proxy tới dev server) kèm overlay; bỏ cổng thì tự chọn cổng trống
                            serve <N1> <N2>: hai số thì cổng đang có server là dev server, cổng còn lại là cổng overlay
                            --cmd "<lệnh>" (với URL): tự chạy dev server, chờ sẵn sàng rồi mới mở proxy; --wait <giây> (mặc định 60)
  serve --list | serve --stop <cổng>
  install [--path] | install-skill | install-mcp | install-shim [--path]   cài skill, MCP (phạm vi user) và lệnh tl-ui-feedback (--path: tự thêm vào PATH người dùng, Windows)
  install-hooks | uninstall-hooks   thêm/gỡ hook xin quyền (PermissionRequest) vào Claude Code (~/.claude/settings.json) và Codex (~/.codex/hooks.json)
  permission-hook           (do agent gọi) chuyển yêu cầu xin quyền lên trang để bạn bấm Cho phép/Từ chối
  uninstall                 gỡ skill, MCP, shim và hook xin quyền (chỉ những gì install/install-hooks đã cài)
  url | token | stop
Ngôn ngữ: UIFB_LANG=vi|en`, `tl-ui-feedback <command>
  start                     start the bridge in the background (auto-started when needed)
  poll [--origin URL | --any] [--timeout-ms N] [--json]   wait for feedback (--origin is required while a serve is running)
  reply "<text>" | reply - [--id fb_..] [--origin URL]  reply, shown in the page (pass --origin when there is no id); "-" reads stdin for multi-line text
  status                    queued feedback / listening agents
  serve [port] <folder|file.html|http://localhost:PORT> [--spa] [--no-open] [--allow-remote-upstream]
                            serve a site (or proxy a dev server) with the overlay; without a port a free one is picked
                            serve <N1> <N2>: with two numbers, the port that has a server is the dev server, the other is the overlay port
                            --cmd "<command>" (with a URL): start the dev server, wait until it answers, then proxy; --wait <seconds> (default 60)
  serve --list | serve --stop <port>
  install [--path] | install-skill | install-mcp | install-shim [--path]   install the skill, MCP (user scope) and the tl-ui-feedback command (--path: add it to the user PATH, Windows)
  install-hooks | uninstall-hooks   add/remove the PermissionRequest hook for Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json)
  permission-hook           (called by the agent) forwards a permission request to the page for Allow/Deny
  uninstall                 remove the skill, MCP, shim and permission hooks (only what install/install-hooks added)
  url | token | stop
Language: UIFB_LANG=vi|en`)

try {
  if (cmd === 'start') {
    console.log('bridge:', await ensureServer())
  } else if (cmd === 'poll') {
    const r = await poll({ origin: flag('origin'), timeoutMs: flag('timeout-ms') != null ? +flag('timeout-ms') : undefined, allowAny: rest.includes('--any') })
    if (rest.includes('--json')) console.log(JSON.stringify(r, null, 2))
    else if (r.status === 'unanswered') console.log(formatUnanswered(r))
    else {
      console.log(`status: ${r.status}  count: ${r.count}`)
      for (const it of r.items) console.log('\n' + formatItem(it))
      console.log('\nnext_step: ' + nextStep(r.count))
    }
  } else if (cmd === 'reply') {
    if (!positional[0]) throw new Error(L('thiếu nội dung trả lời', 'missing reply text'))
    // `-`: đọc nội dung từ stdin. Cần khi có xuống dòng: shim .cmd trên Windows cắt đối số ở dấu xuống dòng.
    if (positional[0] === '-' && process.stdin.isTTY) throw new Error(L('reply - đọc nội dung từ stdin: hãy pipe vào, ví dụ: echo "nội dung" | tl-ui-feedback reply - --id <id>', 'reply - reads stdin: pipe the text in, e.g. echo "text" | tl-ui-feedback reply - --id <id>'))
    const text = positional[0] === '-' ? fs.readFileSync(0, 'utf8').replace(/\r\n/g, '\n').trim() : positional[0]
    if (!text) throw new Error(L('nội dung trả lời rỗng', 'reply text is empty'))
    console.log(JSON.stringify(await reply(text, flag('id'), flag('origin'))))
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await status()))
  } else if (cmd === 'install' || cmd === 'install-skill' || cmd === 'install-mcp' || cmd === 'install-shim') {
    if (cmd === 'install' || cmd === 'install-skill') console.log(L('skill đã cài:', 'skill installed:'), inst.installSkill({ root: ROOT }))
    if (cmd === 'install' || cmd === 'install-mcp') installMcp()
    if (cmd === 'install' || cmd === 'install-shim') installShim(rest.includes('--path'))
    if (cmd !== 'install-shim') {
      const dup = inst.enabledPlugins()
      if (dup.length) console.log(L(`CẢNH BÁO: plugin ${dup.join(', ')} đang bật cùng bản install này, skill và MCP sẽ bị nạp trùng. Chọn MỘT: gỡ plugin (claude plugin uninstall ${dup[0]}) hoặc chạy \`tl-ui-feedback uninstall\`.`, `WARNING: plugin ${dup.join(', ')} is enabled alongside this install, so the skill and MCP load twice. Pick ONE: remove the plugin (claude plugin uninstall ${dup[0]}) or run \`tl-ui-feedback uninstall\`.`))
      console.log(L('Mở phiên Claude Code MỚI để nạp skill và tool MCP.', 'Start a NEW Claude Code session to load the skill and MCP tools.'))
    }
  } else if (cmd === 'install-hooks') {
    for (const r of inst.installHooks({ root: ROOT })) console.log(r.agent + ': ' + (r.error ? L('LỖI, không sửa ', 'ERROR, left unchanged: ') + r.file + ' (' + r.error + ')' : r.skipped ? L('bỏ qua (chưa có thư mục cấu hình)', 'skipped (no config folder)') : L('đã thêm hook vào ', 'hook added to ') + r.file))
    console.log(L('Mở phiên agent MỚI để nạp hook. Codex có thể hỏi bạn tin cậy hook mới ở lần chạy đầu (/hooks). Hook chỉ hoạt động khi đang có yêu cầu UI chưa được trả lời; còn lại agent hỏi như thường.', 'Start a NEW agent session to load the hook. Codex may ask you to trust the new hook on first run (/hooks). The hook only acts while a UI request is unanswered; otherwise the agent asks as usual.'))
  } else if (cmd === 'uninstall-hooks') {
    for (const r of inst.uninstallHooks()) console.log(r.agent + ': ' + (r.changed ? L('đã gỡ hook khỏi ', 'hook removed from ') + r.file : L('không có hook của tl-ui-feedback', 'no tl-ui-feedback hook')))
  } else if (cmd === 'uninstall') {
    console.log(inst.uninstallSkill() ? L('đã gỡ skill', 'skill removed') : L('không có skill tl-ui-feedback của chúng ta để gỡ', 'no tl-ui-feedback skill of ours to remove'))
    // Hook trỏ tới cli.mjs của bản cài này: để lại sau khi gỡ thì agent chạy một lệnh mồ côi ở mỗi lần xin quyền.
    for (const r of inst.uninstallHooks()) if (r.changed) console.log(L('đã gỡ hook xin quyền khỏi ', 'permission hook removed from ') + r.file)
    console.log(uninstallMcp() ? L('đã gỡ MCP tl-ui-feedback', 'tl-ui-feedback MCP removed') : L('không gỡ được MCP (chưa đăng ký, hoặc chưa có lệnh claude)', 'could not remove the MCP server (not registered, or no claude command)'))
    console.log(inst.removeShim() ? L('đã gỡ lệnh tl-ui-feedback', 'tl-ui-feedback command removed') : L('không có shim để gỡ', 'no shim to remove'))
    console.log(L('Nếu đã thêm thư mục bin vào PATH, hãy tự bỏ dòng đó. Trạng thái trong ~/.ui-feedback/ được giữ nguyên.', 'If you added the bin folder to PATH, remove it yourself. State in ~/.ui-feedback/ is kept.'))
  } else if (cmd === 'serve') {
    if (rest[0] === '--list') {
      const l = listServes()
      console.log(l.length ? l.map((s) => `${s.port}  ${s.mode}  ${s.site}  pid ${s.pid}`).join('\n') : L('không có site nào đang chạy', 'no site is running'))
    } else if (rest[0] === '--stop') {
      if (!rest[1]) throw new Error(L('thiếu cổng: serve --stop <cổng>', 'missing port: serve --stop <port>'))
      console.log((await stopServe(rest[1])) ? L(`đã dừng ${rest[1]}`, `stopped ${rest[1]}`) : L(`không có site nào ở cổng ${rest[1]}`, `no site on port ${rest[1]}`))
    } else {
      const valueFlags = new Set(['cmd', 'wait'])
      const args = []
      const opts = {}
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]
        if (!a.startsWith('--')) args.push(a)
        else if (valueFlags.has(a.slice(2))) opts[a.slice(2)] = rest[++i]
        else opts[a.slice(2)] = true
      }
      const USAGE = L('dùng: serve [cổng] <thư-mục|file.html|URL> [--cmd "<lệnh dev server>"] [--wait <giây>] [--spa] [--no-open] [--allow-remote-upstream]  (bỏ cổng thì tự chọn cổng trống)',
        'usage: serve [port] <folder|file.html|URL> [--cmd "<dev server command>"] [--wait <seconds>] [--spa] [--no-open] [--allow-remote-upstream]  (without a port a free one is picked)')
      const isNum = (a) => /^\d+$/.test(a)
      if (args.length === 1 && isNum(args[0])) throw new Error(L('thiếu site sau cổng ' + args[0] + '. ', 'missing site after port ' + args[0] + '. ') + USAGE)
      if (args.length < 1 || args.length > 2 || (args.length === 2 && !isNum(args[0]) && !isNum(args[1]))) throw new Error(USAGE)
      let port = 0, site = args[0]
      if (args.length === 2 && isNum(args[0]) && isNum(args[1])) {
        // Hai số: thứ tự không nói cổng nào là dev server. Cổng có server trả lời (không phải một serve của ta) là dev server.
        const ours = new Set(listServes().map((x) => x.port))
        const up = await Promise.all(args.map(async (n) => !ours.has(+n) && (await probe(`http://localhost:${n}`))))
        if (up[0] === up[1]) {
          throw new Error(L(`không đoán được cổng dev server: ${up[0] ? 'cả hai cổng' : 'không cổng nào'} (${args.join(', ')}) đang có server. Ghi rõ: serve <cổng overlay> http://localhost:<cổng dev>`,
            `cannot tell which port is the dev server: ${up[0] ? 'both ports' : 'neither port'} (${args.join(', ')}) has a server. Be explicit: serve <overlay port> http://localhost:<dev port>`))
        }
        const [dev, ov] = up[0] ? args : [args[1], args[0]]
        port = +ov
        site = `http://localhost:${dev}`
        console.error(L(`hai số: dev server localhost:${dev} (đang chạy), cổng overlay ${ov}`, `two numbers: dev server localhost:${dev} (running), overlay port ${ov}`))
      } else if (args.length === 2) {
        // Một cổng và một site, thứ tự nào cũng được.
        ;[port, site] = isNum(args[0]) ? [+args[0], args[1]] : [+args[1], args[0]]
      }
      const isUrl = /^https?:\/\//i.test(site)
      if ('cmd' in opts && (!opts.cmd || opts.cmd.startsWith('--'))) throw new Error(L('--cmd cần một lệnh, vd ', '--cmd needs a command, e.g. ') + '--cmd "npx expo start --web --port 8081"')
      if (opts.cmd && !isUrl) throw new Error(L('--cmd chỉ dùng với site là URL của dev server mà lệnh sẽ mở, vd http://localhost:8081', '--cmd only works with a site URL of the dev server the command starts, e.g. http://localhost:8081'))
      const waitS = opts.wait !== undefined ? +opts.wait : 60
      if (!(waitS > 0)) throw new Error(L('--wait phải là số giây > 0', '--wait must be a number of seconds > 0'))
      let dev = null
      if (opts.cmd) {
        console.error(L(`đang chạy: ${opts.cmd}  (chờ ${site} tối đa ${waitS} giây)`, `running: ${opts.cmd}  (waiting up to ${waitS}s for ${site})`))
        dev = await runDevCommand({ command: opts.cmd, upstream: site, timeoutMs: waitS * 1000 })
      }
      let s
      try {
        const bridgeUrl = await ensureServer()
        s = await startServe({ port, site, bridgeUrl, spa: !!opts.spa, allowRemote: !!opts['allow-remote-upstream'], childPid: dev ? dev.pid : null })
      } catch (e) {
        dev?.stop()
        throw e
      }
      const url = `http://localhost:${s.port}`
      console.log(L(`đang phục vụ ${isUrl ? 'proxy tới ' + site : path.resolve(site)} tại ${url}  (Ctrl+C để dừng)`, `serving ${isUrl ? 'proxy to ' + site : path.resolve(site)} at ${url}  (Ctrl+C to stop)`))
      if (!opts['no-open']) {
        const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
        spawnSync(c, a, { stdio: 'ignore' })
      }
      const bye = () => { dev?.stop(); return s.close().then(() => process.exit(0)) }
      process.on('SIGINT', bye)
      process.on('SIGTERM', bye)
      dev?.child.on('exit', (code) => {
        console.error(L(`lệnh dev server đã thoát (mã ${code}); dừng serve`, `dev server command exited (code ${code}); stopping serve`))
        s.close().then(() => process.exit(1))
      })
      await new Promise(() => {}) // giữ tiến trình sống tới khi nhận tín hiệu
    }
  } else if (cmd === 'url') {
    console.log(baseUrl())
  } else if (cmd === 'token') {
    console.log(loadOrCreateToken())
  } else if (cmd === 'stop') {
    // Chỉ kill khi bridge đang trả lời đúng PID trong server.json: file cũ còn sót có thể trỏ tới PID đã bị tiến trình khác dùng lại.
    let pid = 0
    try {
      pid = JSON.parse(fs.readFileSync(path.join(stateDir(), 'server.json'), 'utf8')).pid
      const h = await (await fetch(baseUrl() + '/health', { signal: AbortSignal.timeout(1500) })).json()
      if (h.name !== 'ui-feedback' || (h.pid && h.pid !== pid)) pid = 0
    } catch { pid = 0 }
    if (pid) { process.kill(pid); console.log('stopped', pid) } else console.log(L('bridge không chạy', 'bridge is not running'))
  } else {
    console.log(HELP())
  }
} catch (e) {
  console.error(L('lỗi:', 'error:'), e.message)
  process.exit(1)
}
