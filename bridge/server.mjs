// UI Feedback Bridge — server local (Node thuần, không dependency).
// Nhận phản hồi UI từ overlay (do `serve` hoặc script dev chèn), giữ hàng đợi, agent lấy qua long-poll.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createSourceMapResolver } from './sourcemap.mjs'
import { createAllowList, pairKey, originToken, originSseKey } from './remote.mjs'
import { parseImages, imageMeta, removeImages, sweepImages, imageDir, MAX_IMAGE_TOTAL, MAX_FEEDBACK_BODY } from './images.mjs'

export const DEFAULT_PORT = 47831
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const OVERLAY_FILE = path.resolve(HERE, '../overlay/overlay.js')
// Client so phiên bản qua /health để thay bridge cũ còn chạy nền sau khi nâng cấp.
export const VERSION = JSON.parse(fs.readFileSync(path.resolve(HERE, '../package.json'), 'utf8')).version
export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const ORIGIN_OK = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$/
const MAX_BODY = 256 * 1024
// API mà trang ngoài localhost được gọi (bằng token riêng của origin đó).
const REMOTE_ROUTES = new Set(['GET /api/history', 'POST /api/history/clear', 'POST /api/feedback', 'POST /api/feedback/resend', 'GET /api/events', 'GET /api/image'])

export function stateDir() {
  return process.env.UIFB_HOME || path.join(os.homedir(), '.ui-feedback')
}

export function loadOrCreateToken(dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'token')
  try {
    const t = fs.readFileSync(f, 'utf8').trim()
    if (t.length >= 32) return t
  } catch {}
  const t = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(f, t, { mode: 0o600 })
  return t
}

// Chỉ cho gọi Metro trên loopback (chặn SSRF).
export function isLoopbackOrigin(o) {
  try {
    const u = new URL(o)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

// Header Host phải là loopback (chống DNS rebinding). Dùng chung cho bridge và serve.
export const isLoopbackHost = (req) => LOOPBACK.has((req.headers.host || '').replace(/:\d+$/, ''))

// Khóa riêng cho SSE: EventSource không đặt được header nên khóa phải nằm trên URL. Khóa này chỉ mở được /api/events
// (chỉ đọc), để URL có lộ ra (log, lịch sử) cũng không dùng được để gọi API.
export const sseKey = (token) => crypto.createHmac('sha256', token).update('ui-feedback-sse').digest('hex').slice(0, 48)

const norm = (file) => file.replace(/\\/g, '/')
// Một tin gửi tối đa 10 phần tử, nhãn A–J (overlay gán theo thứ tự chọn).
const REFS = 'ABCDEFGHIJ'.split('')
const MAX_ELEMENTS = REFS.length

// stacks: [{ comp, lines: ["at fn (url:line:col)", ...] }] lấy từ fiber._debugStack ở trình duyệt.
export async function symbolicate(metroOrigin, stacks, fetchImpl = fetch) {
  if (!isLoopbackOrigin(metroOrigin)) throw Object.assign(new Error('metro origin not loopback'), { status: 400 })
  const parse = (l) => {
    const m = String(l).match(/at (?:(\S+) )?\(?(https?:\/\/[^\s)]+?):(\d+):(\d+)\)?$/)
    return m ? { methodName: m[1] || '', file: m[2], lineNumber: +m[3], column: +m[4] } : null
  }
  const out = []
  const seen = new Set()
  for (const st of (stacks || []).slice(0, 12)) {
    const frames = (st.lines || []).slice(0, 30).map(parse).filter(Boolean)
    if (!frames.length) continue
    let r
    try {
      r = await fetchImpl(new URL('/symbolicate', metroOrigin), {
        method: 'POST',
        body: JSON.stringify({ stack: frames }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (e) {
      out.push({ element: st.comp, error: 'symbolicate failed: ' + e.message })
      break
    }
    // Dev server không phải Metro (Vite, Next...): 404/405 hoặc không trả JSON có stack. Báo để gọi dùng source map.
    const notMetro = (sticky) => Object.assign(new Error('not metro'), { notMetro: true, sticky })
    if (r.status === 404 || r.status === 405) throw notMetro(true)
    let j
    try { j = await r.json() } catch { throw notMetro(true) }
    if (!j || !Array.isArray(j.stack)) throw notMetro(false)
    const u = (j.stack || []).find((f) => f.file && !/node_modules/.test(f.file))
    if (!u) continue
    const key = `${u.file}:${u.lineNumber}:${u.column}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ element: String(st.comp), createdIn: u.methodName || null, file: norm(u.file), line: u.lineNumber, column: u.column })
    if (out.length >= 8) break
  }
  return out
}

// React 18 dev (JSX dev transform) ghi sẵn fiber._debugSource = { fileName, lineNumber, columnNumber }: không cần source map.
// items: [{ comp, file, line, column }] do overlay gửi (debugSources).
export function fromDebugSources(items) {
  const out = []
  const seen = new Set()
  for (const x of Array.isArray(items) ? items.slice(0, 12) : []) {
    if (!x || typeof x.file !== 'string' || !x.file || x.file.length > 1000 || !Number.isFinite(+x.line)) continue
    const file = norm(x.file)
    if (/node_modules/.test(file)) continue
    const line = +x.line
    const column = Number.isFinite(+x.column) ? +x.column : null
    const key = `${file}:${line}:${column}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ element: String(x.comp ?? '').slice(0, 200), createdIn: null, file, line, column })
    if (out.length >= 8) break
  }
  return out
}

// Chuẩn hóa đường dẫn để so sánh: gạch xuôi, bỏ gạch cuối; chỉ hạ chữ thường trên Windows/macOS (Linux phân biệt hoa thường).
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin'
export const normPath = (d) => { const n = String(d || '').replace(/\\/g, '/').replace(/\/+$/, ''); return CASE_FOLD ? n.toLowerCase() : n }
const isProjectRoot = (p) => { try { return fs.existsSync(path.join(p, '.git')) || fs.existsSync(path.join(p, 'package.json')) } catch { return false } }
// Hai thư mục thuộc cùng một phiên agent khi trùng nhau, hoặc một bên là thư mục con của bên kia VÀ bên cha là gốc dự án (có .git/package.json).
// Cha là thư mục rộng (C:\Work, home) thì không khớp, để agent ở dự án khác bên trong không bị gộp nhầm.
export const sameSession = (hook, poller) => !!hook && !!poller && (hook === poller
  || (hook.startsWith(poller + '/') && isProjectRoot(poller))
  || (poller.startsWith(hook + '/') && isProjectRoot(hook)))

// Lệnh/thao tác rủi ro không bao giờ được duyệt từ trang: server không tạo thẻ, agent hỏi ở terminal như thường.
// Đây là lưới an toàn theo mẫu, không phải sandbox: lệnh bị làm rối (vd $(echo r)m) có thể lọt, nên vẫn phải đọc kỹ thẻ trước khi bấm.
const RISKY = [
  ['delete files/folders', /(?:^|[\s;&|(){`'"=])(?:rm|rmdir|unlink|shred|del|erase|rd|rimraf|remove-item)(?=\s|$)/i],
  ['irreversible or outbound git operation', /\bgit\b[^;&|\n]*\s(?:push|clean|rebase|filter-branch|update-ref|reset\s+--(?:hard|merge)|checkout\s+(?:-f|--force|--)|restore|branch\s+-[dD]|stash\s+(?:drop|clear)|reflog\s+(?:expire|delete)|gc\s+--prune|tag\s+-d)(?=\s|$)/i],
  ['package registry publish/login', /\b(?:npm|pnpm|yarn|npx)\b[^;&|\n]*\s(?:publish|unpublish|deprecate|dist-tag|owner|token|adduser|login)(?=\s|$)/i],
  ['system permissions / disks / processes', /(?:^|[\s;&|(){`'"=])(?:sudo|doas|su|chmod|chown|chgrp|mkfs|dd|fdisk|diskpart|format|shutdown|reboot|kill|killall|pkill|taskkill|stop-process|systemctl|launchctl|crontab|schtasks|setx|reg)(?=\s|$)/i],
  ['sends data off the machine (ssh/scp/rsync/nc)', /(?:^|[\s;&|(){`'"=])(?:ssh|scp|sftp|rsync|nc|ncat|telnet)(?=\s|$)/i],
  ['destructive or deploying docker/k8s/terraform/cloud command', /\b(?:docker|podman)\b[^;&|\n]*\s(?:rm|rmi|push|system\s+prune|volume\s+rm|container\s+prune)(?=\s|$)|\b(?:kubectl|helm)\b[^;&|\n]*\s(?:delete|apply|exec|uninstall|upgrade|install)(?=\s|$)|\bterraform\b[^;&|\n]*\s(?:apply|destroy)(?=\s|$)|\b(?:aws|gcloud|az)\b[^;&|\n]*\s(?:delete|terminate|rm|remove|destroy|deploy|put[\w-]*)(?=\s|$)/i],
  ['downloads and runs code', /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sh|bash|zsh|iex|invoke-expression|python3?|node)\b|(?:^|[\s;&|(){`'"=])(?:iex|invoke-expression|eval)(?=\s|$)/i],
  ['overwrites system or key files', /(?:>|tee\s)\s*(?:\/(?:etc|dev|usr|bin|boot)\b|~?\/?\.(?:ssh|bashrc|zshrc|profile|npmrc|netrc)\b)/i],
  ['interpreter running inline code (-c/-e)', /(?:^|[\s;&|(){`'"=])(?:python[\d.]*|py|node|deno|bun|perl|ruby|php|lua)(?:\.exe)?\s+(?:-\S+\s+)*?-(?:c|e|-eval)(?=\s|$)/i],
  ['shell/cmd/powershell running a command string', /(?:^|[\s;&|(){`'"=])(?:(?:ba|z|da|k)?sh|cmd(?:\.exe)?)\s+(?:-\S+\s+)*?(?:-c|\/c|\/k)(?=\s|$)|\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc\w*|c|command)(?=\s|$)/i],
  ['deletes SQL data', /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b/i],
  ['find -delete/-exec', /\bfind\b[^\n]*\s-(?:delete|exec(?:dir)?)\b/i],
]
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.env[^\\/]*|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa[^\\/]*|id_ed25519[^\\/]*|credentials[^\\/]*|\.git[\\/](?:hooks|config)|\.claude[\\/]settings[^\\/]*|\.codex)(?:[\\/]|$)/i
const READ_ONLY_TOOL = /^(?:Read|Grep|Glob|LS|NotebookRead|read_file|list_dir)$/i
// Trả về lý do rủi ro (chuỗi) hoặc '' nếu có thể cho phép từ trang. Dùng chung cho hook (không in mã) và server (chặn thật).
export function riskyReason(tool, input, cwd) {
  const verb = READ_ONLY_TOOL.test(String(tool || '')) ? 'reads' : 'writes'
  const inp = input && typeof input === 'object' ? input : {}
  if (typeof inp.command === 'string' || typeof inp.cmd === 'string') {
    const cmd = String(inp.command ?? inp.cmd)
    for (const [why, re] of RISKY) if (re.test(cmd)) return why
  }
  const f = inp.file_path ?? inp.path ?? inp.notebook_path
  if (typeof f === 'string') {
    if (SENSITIVE_PATH.test(f)) return 'sensitive file (keys, .env, agent config)'
    const abs = /^(?:[a-z]:)?[\\/]/i.test(f) || f.startsWith('~')
    const n = normPath(f)
    const root = normPath(cwd)
    if (/(?:^|\/)\.\.(?:\/|$)/.test(n)) return 'path escapes the project folder'
    if (abs && (!root || !(n === root || n.startsWith(root + '/')))) return verb + ' outside the project folder'
  }
  return ''
}

// Sau khi giao cho poller, agent phải xác nhận (ack) hoặc trả lời trong ngần này ms, nếu không tin về hàng đợi.
export const DEFAULT_ACK_MS = 60000
// Sau `received`, agent phải trả lời trong ngần này ms, nếu không tin thành `expired` (UIFB_RECEIVED_MS, 0 = tắt).
export const DEFAULT_RECEIVED_MS = 15 * 60000

export function createBridge({ port = DEFAULT_PORT, dir = stateDir(), fetchImpl = fetch, ackMs = process.env.UIFB_ACK_MS != null ? +process.env.UIFB_ACK_MS : DEFAULT_ACK_MS, receivedMs = process.env.UIFB_RECEIVED_MS != null ? +process.env.UIFB_RECEIVED_MS : DEFAULT_RECEIVED_MS, permMinMs = 5000, remindMs = 60000, loopMs = 30 * 60000, imgDir = imageDir(), imageTotal = MAX_IMAGE_TOTAL } = {}) {
  const token = loadOrCreateToken(dir)
  const allow = createAllowList(dir) // origin ngoài localhost đã `tl-ui-feedback allow`
  const sourceMaps = createSourceMapResolver({ fetchImpl })
  // origin -> hết hạn (ms): đã biết không phải Metro, khỏi POST /symbolicate (Next sẽ render trang 404 mỗi lần).
  const notMetro = new Map()
  // Thứ tự: _debugSource (React 18; dưới Vite chỉnh dòng qua /@fs/) -> Metro /symbolicate (Expo) -> source map của dev server (Vite, Next).
  async function resolveSource(origin, stacks, debugSources) {
    const direct = fromDebugSources(debugSources)
    if (direct.length) return sourceMaps.remapDebugSources(origin, direct)
    if (!Array.isArray(stacks) || !stacks.length) return []
    if (!(notMetro.get(origin) > Date.now())) {
      try {
        return await symbolicate(origin, stacks, fetchImpl)
      } catch (e) {
        if (!e.notMetro) throw e
        if (e.sticky) notMetro.set(origin, Date.now() + 5 * 60000)
      }
    }
    return sourceMaps.resolve(origin, stacks)
  }
  const queue = [] // {id,...}
  const items = new Map()
  const waiters = [] // {res, origin, timer}
  const sse = new Set() // res; res.uifbScope = origin ngoài localhost nếu luồng thuộc trang đó
  let seq = 0

  // Luồng của origin ngoài localhost chỉ thấy sự kiện của chính nó: không thấy tin của site khác, tin agent không origin
  // hay thẻ xin quyền (origin đó không bao giờ được duyệt quyền).
  const scopedEvent = (obj, scope) => {
    if (obj.type === 'presence') return scopedPresence(scope)
    if (obj.type === 'message') return obj.entry?.origin === scope ? obj : null
    if (obj.type === 'status' || obj.type === 'clear') return obj.origin === scope ? obj : null
    return null
  }
  // Luồng của origin ngoài localhost chỉ sống khi origin còn được allow với đúng nonce lúc mở luồng: `allow --remove`,
  // hết hạn hay allow lại với nonce mới đều cắt luồng đang mở (allow chỉ được kiểm khi request tới).
  const scopeLive = (r) => { const e = allow.get(r.uifbScope); return !!e && (e.nonce || '') === r.uifbNonce }
  const sendEvent = (obj) => {
    const all = `data: ${JSON.stringify(obj)}\n\n`
    for (const r of sse) {
      if (!r.uifbScope) { r.write(all); continue }
      if (!scopeLive(r)) { sse.delete(r); r.end(); continue }
      const v = scopedEvent(obj, r.uifbScope)
      if (v) r.write(`data: ${JSON.stringify(v)}\n\n`)
    }
  }
  // Presence theo origin: waiter không lọc origin nghe mọi site; waiter có origin chỉ nghe site đó.
  const listeningFor = (o) => waiters.some((w) => !w.origin || w.origin === o)
  const presenceState = () => ({
    type: 'presence',
    listening: waiters.length > 0, // tương thích cũ: có agent nào đang chờ
    any: waiters.some((w) => !w.origin),
    origins: [...new Set(waiters.filter((w) => w.origin).map((w) => w.origin))],
  })
  const scopedPresence = (o) => {
    const on = listeningFor(o)
    return { type: 'presence', listening: on, any: false, origins: on ? [o] : [] }
  }
  const presence = () => sendEvent(presenceState())

  // Bỏ một tin khỏi bộ nhớ, kèm file ảnh tạm CLI đã ghi cho nó.
  const dropItem = (id) => {
    const it = items.get(id)
    items.delete(id)
    if (it?.images?.length) removeImages(id, imgDir)
  }
  // Tổng dung lượng ảnh đang giữ. Vượt trần: bỏ ảnh của tin đã trả lời trước, rồi mới tới tin `expired`
  // (agent có thể vẫn đang làm: tin tiến độ cứu nó về `received`); trong mỗi lượt cũ trước (Map giữ thứ tự thêm vào).
  const imageBytes = () => { let n = 0; for (const it of items.values()) for (const g of it.images || []) n += g.data ? g.bytes : 0; return n }
  const makeRoomForImages = (need) => {
    let used = imageBytes()
    for (const status of ['replied', 'expired']) {
      for (const it of items.values()) {
        if (used + need <= imageTotal) return true
        if (it.status !== status || !it.images?.some((g) => g.data)) continue
        for (const g of it.images) { used -= g.data ? g.bytes : 0; delete g.data }
        removeImages(it.id, imgDir)
        const e = thread.find((x) => x.itemId === it.id)
        if (e?.images) e.imagesEvicted = true
      }
    }
    return used + need <= imageTotal
  }
  // Lịch sử hội thoại (chỉ trong bộ nhớ, không ghi đĩa): yêu cầu của người dùng + phản hồi của agent.
  const thread = []
  const MAX_THREAD = 500
  const pushEntry = (e) => {
    thread.push(e)
    if (thread.length > MAX_THREAD) {
      // Tin cũ rơi khỏi lịch sử: bỏ luôn item đã có kết cục, nếu không `items` lớn mãi trong phiên bridge dài.
      const old = thread.shift()
      const it = old.role === 'user' && items.get(old.itemId)
      if (it && (it.status === 'replied' || it.status === 'expired')) dropItem(it.id)
    }
    sendEvent({ type: 'message', entry: e })
  }
  const setStatus = (id, status, extra = {}) => {
    const e = thread.find((x) => x.id === id)
    if (!e) return
    // unacked chỉ có nghĩa khi tin đang nằm lại hàng đợi; sang trạng thái khác (đã giao/đã đọc/đã trả lời) thì về 0.
    const un = status === 'queued' ? extra.unacked ?? e.unacked ?? 0 : 0
    if (e.status === status && (e.unacked || 0) === un) return
    e.status = status
    e.unacked = un
    sendEvent({ type: 'status', id, status, origin: e.origin, unacked: un })
  }
  // Xin quyền từ agent (hook PermissionRequest của Claude Code / Codex): giữ kết nối tới khi người dùng quyết định trên trang.
  // Chỉ nhận khi đang có yêu cầu UI chưa được trả lời; không có thì hook rơi về hộp thoại xác nhận thường của agent.
  const perms = new Map() // id -> {id,tool,detail,cwd,who,origins,createdAt,expiresAt,status,res,timer}
  const pubPerm = (p) => ({ id: p.id, tool: p.tool, detail: p.detail, cwd: p.cwd, cwdKey: p.cwdKey, origins: p.origins, createdAt: p.createdAt, expiresAt: p.expiresAt })
  const pendingPerms = (o) => [...perms.values()].filter((p) => p.status === 'pending' && (!o || p.origins.includes(o))).map(pubPerm)
  const finishPerm = (p, status, extra = {}) => {
    if (p.status !== 'pending') return false
    p.status = status
    clearTimeout(p.timer)
    sendEvent({ type: 'permission-done', id: p.id, status, origins: p.origins })
    if (p.res && !p.res.writableEnded) json(p.res, 200, { decision: status === 'allowed' ? 'allow' : status === 'denied' ? 'deny' : 'none', ...extra })
    setTimeout(() => perms.delete(p.id), 60000).unref?.()
    return true
  }
  // Chỉ các site có tin đang được CHÍNH agent đó xử lý mới nhận thẻ xin quyền: hook cài toàn cục nên mọi phiên agent khác
  // trên máy cũng gọi vào đây. Không khớp được thì bỏ qua (agent hỏi ở terminal như thường).
  // who của poller = "pid N [#agent=PID] @ cwd" (#agent đứng trước cwd để không bị cắt khi `who` quá 200 ký tự).
  // #agent là PID tiến trình agent cha (xem agentproc.mjs). Cả hai bên đều có PID thì so PID: đúng phiên dù cwd khác,
  // hai phiên cùng cwd vẫn tách được. Thiếu một bên thì rơi về so cwd.
  const cwdOf = (who) => { const i = String(who || '').indexOf(' @ '); return i < 0 ? '' : normPath(who.slice(i + 3)) }
  const agentOf = (who) => +(String(who || '').match(/^pid \d+ #agent=(\d+) @ /)?.[1] || 0)
  // Nhớ session_id → PID agent (hook có session_id ổn định): chỉ lần hook đầu của một phiên phải dò tiến trình (~0,6s),
  // các lần sau server đã biết PID. Hết hạn sau 5 phút (agent chạy lại/resume có thể đổi PID); sai thì chỉ làm agent hỏi ở terminal.
  const SESS_TTL = 5 * 60000
  const sessAgent = new Map() // session_id -> { agent, at }
  const sidOf = (s) => String(s || '').slice(0, 100)
  const knownAgent = (sid) => {
    const e = sid && sessAgent.get(sid)
    if (!e) return 0
    if (Date.now() - e.at > SESS_TTL) { sessAgent.delete(sid); return 0 }
    e.at = Date.now()
    return e.agent
  }
  const rememberAgent = (sid, agent) => {
    if (!sid || !(+agent > 0)) return
    sessAgent.delete(sid)
    sessAgent.set(sid, { agent: +agent, at: Date.now() })
    if (sessAgent.size > 200) sessAgent.delete(sessAgent.keys().next().value)
  }
  // Phiên agent đang trong vòng UI feedback của một origin (poll/ack/reply gần đây). Chỉ dựa vào tin đang xử lý thì thiếu:
  // agent xin quyền SAU khi đã reply có id (chạy test, build...) hoặc làm quá 15 phút (tin `expired`) sẽ bị đẩy về terminal.
  // Đường này chỉ áp dụng khi trang của origin đang mở (có SSE), để agent không phải chờ thẻ không ai thấy.
  // Agent rời vòng (người dùng ngắt poll: Esc, "dừng", MCP hủy, CLI bị kill) thì xóa ngay: xem endLoop ở /api/poll.
  const LOOP_MS = loopMs
  const loops = new Map() // who -> { who, origin, at }
  const endLoop = (who) => { for (const k of [...loops.keys()]) if (samePoller(who, k)) loops.delete(k) }
  const touchLoop = (who, origin) => {
    if (!who || !origin) return
    loops.delete(who)
    loops.set(who, { who, origin, at: Date.now() })
    if (loops.size > 200) loops.delete(loops.keys().next().value)
  }
  const pages = new Map() // origin -> số kết nối SSE của trang đang mở
  const liveLoops = () => [...loops.values()].filter((l) => Date.now() - l.at < LOOP_MS && pages.get(l.origin) > 0)
  const activeOrigins = (cwd, agent = 0) => {
    const c = normPath(cwd)
    const a = +agent || 0
    const match = (who) => { const pa = agentOf(who); return a && pa ? a === pa : sameSession(c, cwdOf(who)) }
    // Chỉ origin localhost: trang ngoài localhost không bao giờ nhận thẻ xin quyền (agent hỏi ở terminal).
    return [...new Set([
      ...[...items.values()]
        .filter((i) => i.origin && (i.status === 'delivered' || i.status === 'received') && match(i.deliveredTo?.who || i.receivedBy))
        .map((i) => i.origin),
      // Vòng lặp chỉ khớp theo PID agent (cả hai bên phải có): so cwd quá lỏng cho cửa sổ 30 phút, một phiên khác cùng dự án
      // sẽ nhận thẻ và người dùng dễ duyệt nhầm lệnh của nó.
      ...liveLoops().filter((l) => { const pa = agentOf(l.who); return a && pa && a === pa }).map((l) => l.origin),
    ])].filter((o) => ORIGIN_OK.test(o))
  }
  // Tin agent đã nhận nhưng chưa trả lời, mà CHÍNH phiên đó đã quay lại poll: agent quên reply (thường gặp với câu hỏi,
  // agent trả lời trong terminal). Poll trả ngay một lời nhắc (mỗi tin một lần), nếu không trang hiện "đang làm" tới khi hết hạn.
  const samePoller = (a, b) => {
    if (!a || !b) return false
    if (a === b) return true
    const pa = agentOf(a), pb = agentOf(b)
    return pa && pb ? pa === pb : sameSession(cwdOf(a), cwdOf(b))
  }
  const unansweredFor = (who, origin) => [...items.values()].filter((i) => i.status === 'received' && !i.reminded && (!origin || i.origin === origin)
    && Date.now() - (i.receivedAt || 0) >= remindMs && samePoller(who, i.receivedBy || i.deliveredTo?.who))
  const remind = (i) => {
    i.reminded = true
    const e = thread.find((x) => x.id === i.id)
    if (e) e.reminded = true
    sendEvent({ type: 'status', id: i.id, status: i.status, origin: i.origin, unacked: 0, reminded: true })
  }
  // Hẹn giờ chờ ack cho từng tin đã giao: quá hạn mà chưa ack/reply thì trả về hàng đợi để giao lại.
  const ackTimers = new Map()
  const clearAck = (id) => {
    clearTimeout(ackTimers.get(id))
    ackTimers.delete(id)
  }
  const armAck = (it) => {
    clearAck(it.id)
    if (!(ackMs > 0)) return
    const t = setTimeout(() => {
      ackTimers.delete(it.id)
      if (it.status !== 'delivered') return
      it.status = 'queued'
      it.unacked = (it.unacked || 0) + 1
      queue.unshift(it)
      setStatus(it.id, 'queued', { unacked: it.unacked })
      wake()
    }, ackMs)
    t.unref?.()
    ackTimers.set(it.id, t)
  }
  // Tin đã `received` mà agent không trả lời trong receivedMs (agent chết/lỗi sau khi ack): chuyển `expired` để trang thôi hiện "đang xử lý".
  // Không giao lại (việc có thể đã làm xong). Trả lời muộn vẫn được nhận và chuyển sang `replied`.
  const receivedTimers = new Map()
  const clearReceived = (id) => {
    clearTimeout(receivedTimers.get(id))
    receivedTimers.delete(id)
  }
  const armReceived = (it) => {
    clearReceived(it.id)
    if (!(receivedMs > 0)) return
    const t = setTimeout(() => {
      receivedTimers.delete(it.id)
      if (it.status !== 'received') return
      it.status = 'expired'
      setStatus(it.id, 'expired')
    }, receivedMs)
    t.unref?.()
    receivedTimers.set(it.id, t)
  }

  function cors(req, res) {
    const o = req.headers.origin
    if (o && (ORIGIN_OK.test(o) || allow.has(o))) {
      res.setHeader('Access-Control-Allow-Origin', o)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
  }
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req, max = MAX_BODY) =>
    new Promise((resolve, reject) => {
      let n = 0
      const chunks = []
      req.on('data', (c) => {
        n += c.length
        if (n > max) {
          reject(Object.assign(new Error('body too large'), { status: 413 }))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          reject(Object.assign(new Error('invalid json'), { status: 400 }))
        }
      })
      req.on('error', reject)
    })
  const same = (t, want) => {
    const a = Buffer.from(String(t || ''))
    const b = Buffer.from(want)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  const sse_key = sseKey(token)
  // Token chính chỉ nhận qua header. Riêng /api/events nhận thêm ?sse=<khóa SSE> (EventSource không đặt được header).
  const authed = (req, url) => {
    const h = req.headers.authorization || ''
    if (h.startsWith('Bearer ') && same(h.slice(7), token)) return true
    return url.pathname === '/api/events' && req.method === 'GET' && same(url.searchParams.get('sse'), sse_key)
  }
  const newId = () => 'fb_' + String(++seq).padStart(2, '0') + '_' + crypto.randomBytes(3).toString('hex')
  // Mục chat của người dùng cho một item (dùng chung cho gửi mới và gửi lại).
  const chipOf = (element, source) => {
    const el = element || {}
    const comps = source?.components || []
    const top = (source?.frames || []).find((f) => f.file)
    return el.tag ? { label: comps.slice(0, 3).join(' › ') || String(el.tag).toLowerCase(), file: top ? `${top.file}:${top.line}` : null } : null
  }
  const entryFor = (item) => {
    const e = {
      id: item.id, ts: item.createdAt, role: 'user', text: item.note, itemId: item.id, status: 'queued', origin: item.origin,
      element: chipOf(item.element, item.source),
    }
    if (item.elements?.length) e.elements = item.elements.map((x) => ({ ref: x.ref, note: x.note, ...chipOf(x.element, x.source) }))
    if (item.images?.length) e.images = imageMeta(item.images)
    return e
  }
  const enqueue = (item) => {
    items.set(item.id, item)
    pushEntry(entryFor(item))
    queue.push(item)
    wake()
    return { id: item.id, queued: true, listening: listeningFor(item.origin) }
  }

  function takeFor(origin) {
    const taken = []
    for (let i = 0; i < queue.length; ) {
      const it = queue[i]
      if (it.status !== 'queued') { queue.splice(i, 1); continue } // đã trả lời/đã nhận trong lúc nằm hàng đợi: không giao lại
      if (!origin || it.origin === origin) {
        queue.splice(i, 1)
        taken.push(it)
      } else i++
    }
    return taken
  }
  // canAck: poller (CLI/MCP) hứa sẽ gọi /api/ack. Poller gọi thẳng /api/poll không ack được nên coi như đã nhận ngay, tránh giao lặp.
  function deliver(res, list, who = '', canAck = false) {
    list.forEach((i) => {
      i.deliveredTo = { who, at: new Date().toISOString() }
      touchLoop(who, i.origin)
      if (canAck) {
        i.status = 'delivered'
        setStatus(i.id, 'delivered')
        armAck(i)
      } else {
        i.status = 'received'
        i.receivedBy = who
        i.receivedAt = Date.now()
        setStatus(i.id, 'received')
        armReceived(i)
      }
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    // Nếu ghi thất bại (agent ngắt kết nối), đưa lại vào hàng đợi — không mất tin.
    res.end(JSON.stringify({ status: 'feedback', count: list.length, items: list }), (err) => {
      if (err) {
        list.forEach((i) => { clearAck(i.id); clearReceived(i.id); i.status = 'queued'; setStatus(i.id, 'queued') })
        queue.unshift(...list)
        wake() // có thể đang có poller khác chờ: giao ngay thay vì đợi sự kiện kế tiếp
      }
    })
  }
  function wake() {
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]
      const list = takeFor(w.origin)
      if (list.length) {
        waiters.splice(i, 1)
        clearTimeout(w.timer)
        deliver(w.res, list, w.who, w.canAck)
        presence()
        return
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req)) return json(res, 403, { error: 'bad host' })
      const origin = req.headers.origin
      // remote: trang ngoài localhost đã được `allow`. Chỉ dùng token riêng của origin đó, chỉ các API của trang, chỉ dữ liệu của nó.
      const remoteEntry = origin && !ORIGIN_OK.test(origin) ? allow.get(origin) : null
      const remote = remoteEntry ? origin : null
      const nonce = remoteEntry?.nonce || ''
      if (origin && !ORIGIN_OK.test(origin) && !remote) return json(res, 403, { error: 'origin not allowed' })
      cors(req, res)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        return res.end()
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname

      if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, name: 'ui-feedback', version: VERSION, pid: process.pid, listening: waiters.length })
      if (req.method === 'GET' && p === '/overlay.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(fs.readFileSync(OVERLAY_FILE))
      }
      if (req.method === 'GET' && p === '/api/handshake') {
        // Token chỉ cho trang loopback (có header Origin do trình duyệt đặt).
        if (!origin) return json(res, 403, { error: 'browser origin required' })
        if (remote) {
          // Khóa ghép cặp chỉ có trong bookmarklet do `tl-ui-feedback allow` in ra: script khác của site không tự lấy được token.
          if (!same(url.searchParams.get('key'), pairKey(token, remote, nonce))) return json(res, 403, { error: 'pairing key required', pair: true })
          return json(res, 200, { token: originToken(token, remote, nonce), sse: originSseKey(token, remote, nonce), listening: listeningFor(remote), scoped: true, images: true })
        }
        // images: overlay chỉ gửi ảnh khi bridge báo hỗ trợ (bridge cũ còn chạy nền sẽ bỏ qua ảnh hoặc trả 413).
        return json(res, 200, { token, sse: sse_key, listening: listeningFor(origin), images: true })
      }
      if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' })
      let scope = null
      if (remote) {
        const h = req.headers.authorization || ''
        const ok = (h.startsWith('Bearer ') && same(h.slice(7), originToken(token, remote, nonce))) ||
          (p === '/api/events' && req.method === 'GET' && same(url.searchParams.get('sse'), originSseKey(token, remote, nonce)))
        if (!ok) return json(res, 401, { error: 'unauthorized' })
        if (!REMOTE_ROUTES.has(req.method + ' ' + p)) return json(res, 403, { error: 'not allowed for this origin' })
        scope = remote
      } else if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' })

      if (req.method === 'GET' && p === '/api/status') return json(res, 200, {
        queued: queue.length,
        listening: waiters.length,
        pollers: waiters.map((w) => ({ origin: w.origin || null, who: w.who || null, since: w.since })),
        pending: [...items.values()].filter((i) => i.status === 'delivered' || i.status === 'received').map((i) => ({ id: i.id, status: i.status, origin: i.origin, who: i.deliveredTo?.who || null, at: i.deliveredTo?.at || null })),
      })

      if (req.method === 'GET' && p === '/api/history') {
        if (scope) return json(res, 200, { permissions: [], entries: thread.filter((e) => e.origin === scope), listening: listeningFor(scope) })
        const o = url.searchParams.get('origin') || ''
        return json(res, 200, { permissions: pendingPerms(o), entries: thread.filter((e) => !o || e.origin === o || e.origin === ''), listening: o ? listeningFor(o) : waiters.length > 0 })
      }

      // Xóa lịch sử hội thoại của một origin (chỉ phần hiển thị; tin đang chờ giao vẫn được giao).
      if (req.method === 'POST' && p === '/api/history/clear') {
        const o = scope || url.searchParams.get('origin') || ''
        let removed = 0
        for (let i = thread.length - 1; i >= 0; i--) {
          if (!o || thread[i].origin === o) { thread.splice(i, 1); removed++ } // tin origin '' dùng chung cho mọi site: không xóa khi chỉ xóa một site
        }
        // Dọn các tin đã xong của origin này khỏi bộ nhớ (tin đang chờ/đang xử lý giữ lại).
        for (const [id, it] of items) if ((!o || it.origin === o) && (it.status === 'replied' || it.status === 'expired')) dropItem(id)
        sendEvent({ type: 'clear', origin: o })
        return json(res, 200, { cleared: removed })
      }

      if (req.method === 'GET' && p === '/api/permission/probe') {
        const agent = +url.searchParams.get('agent') || knownAgent(sidOf(url.searchParams.get('session')))
        return json(res, 200, {
        active: activeOrigins(url.searchParams.get('cwd') || '', agent).length > 0,
        agent, // PID đã biết của phiên này (0 = chưa biết, hook phải tự dò một lần)
        // Số tin đang được một agent nào đó xử lý (+ vòng UI feedback còn sống): hook dùng để bỏ qua việc dò PID khi không phiên nào đang làm UI feedback.
        candidates: [...items.values()].filter((i) => i.origin && (i.status === 'delivered' || i.status === 'received')).length + liveLoops().length,
        })
      }

      if (req.method === 'POST' && p === '/api/permission') {
        const b = await readBody(req)
        const risk = riskyReason(b.tool, b.input, b.cwd)
        if (risk) return json(res, 200, { decision: 'none', reason: 'risky: ' + risk }) // không bao giờ duyệt từ trang
        const sid = sidOf(b.session)
        rememberAgent(sid, b.agent)
        const origins = activeOrigins(b.cwd, +b.agent || knownAgent(sid))
        if (!origins.length) return json(res, 200, { decision: 'none', reason: 'no active ui feedback for this session' })
        const input = b.input && typeof b.input === 'object' ? b.input : {}
        const detail = String(input.command ?? input.file_path ?? input.path ?? input.url ?? JSON.stringify(input) ?? '').slice(0, 1500)
        const waitMs = Math.min(Math.max(+b.timeoutMs || 100000, permMinMs), 600000)
        const id = 'pm_' + crypto.randomBytes(6).toString('hex')
        const pm = { id, tool: String(b.tool || '?').slice(0, 100), detail, cwd: String(b.cwd || '').slice(0, 300), cwdKey: normPath(b.cwd), who: String(b.who || '').slice(0, 200), origins, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + waitMs).toISOString(), status: 'pending', res }
        pm.timer = setTimeout(() => finishPerm(pm, 'expired'), waitMs)
        perms.set(id, pm)
        // Hook bị tắt (người dùng đã trả lời ở terminal) thì gỡ thẻ xác nhận khỏi trang.
        res.on('close', () => { if (pm.status === 'pending') { pm.res = null; finishPerm(pm, 'cancelled') } })
        sendEvent({ type: 'permission', perm: pubPerm(pm) })
        return
      }

      if (req.method === 'POST' && p === '/api/permission/decide') {
        const b = await readBody(req)
        const pm = typeof b.id === 'string' ? perms.get(b.id) : null
        if (!pm) return json(res, 404, { error: 'unknown id' })
        if (pm.status !== 'pending') return json(res, 409, { error: 'already ' + pm.status })
        if (origin && !pm.origins.includes(origin)) return json(res, 403, { error: 'origin not allowed for this request' })
        if (b.decision !== 'allow' && b.decision !== 'deny') return json(res, 400, { error: 'decision must be allow or deny' })
        // Không đòi mã: lệnh rủi ro đã bị chặn ở /api/permission (không bao giờ có thẻ), còn lại overlay chỉ gửi quyết định từ click thật (isTrusted).
        finishPerm(pm, b.decision === 'allow' ? 'allowed' : 'denied', { message: b.decision === 'deny' ? 'The user denied this on the UI Feedback page.' : undefined })
        return json(res, 200, { ok: true, status: pm.status })
      }

      // Gửi lại một tin cũ trong lịch sử: nhân bản item (giữ nguyên phần tử/stack đã chọn) thành tin mới ở cuối hàng đợi.
      if (req.method === 'POST' && p === '/api/feedback/resend') {
        const b = await readBody(req)
        const old = typeof b.id === 'string' ? items.get(b.id) : null
        if (!old || (scope && old.origin !== scope)) return json(res, 404, { error: 'item not found' })
        // Chỉ sao chép phần nội dung; không mang theo trạng thái giao/nhận (deliveredTo, receivedBy, unacked...) của tin cũ.
        const copy = {
          id: newId(), createdAt: new Date().toISOString(), status: 'queued',
          url: old.url, origin: old.origin, viewport: old.viewport, note: old.note, lang: old.lang ?? null,
        }
        if ('element' in old) { copy.element = old.element; copy.source = old.source }
        if (old.elements) copy.elements = old.elements
        if (old.images?.length) {
          if (old.images.some((g) => !g.data)) return json(res, 410, { error: 'images of this message were dropped from memory' })
          // Sao chép TRƯỚC khi dọn chỗ: tin gốc (đã trả lời) có thể chính là tin bị bỏ ảnh, bản sao vẫn giữ dữ liệu.
          const imgs = old.images.map((g) => ({ ...g }))
          if (!makeRoomForImages(imgs.reduce((n, g) => n + g.bytes, 0))) return json(res, 413, { error: 'image memory full; wait for the agent to answer pending messages' })
          copy.images = imgs
        }
        copy.resentFrom = old.id
        return json(res, 200, enqueue(copy))
      }
      if (req.method === 'POST' && p === '/api/feedback') {
        const b = await readBody(req, MAX_FEEDBACK_BODY)
        const images = parseImages(b.images)
        if (b.note != null && typeof b.note !== 'string') return json(res, 400, { error: 'note required' })
        let pageOrigin = origin || ''
        if (b.url) {
          try { pageOrigin = new URL(String(b.url)).origin } catch { return json(res, 400, { error: 'invalid url' }) }
        }
        if (scope && pageOrigin !== scope) return json(res, 400, { error: 'url must be on ' + scope })
        // Trang ngoài localhost: không tra file:dòng (Metro, source map; bản deploy không có, và trang không được chọn cổng local để bridge gọi).
        const metro = scope ? null : b.metroOrigin || pageOrigin
        const sourceOf = async (components, stacks, debugSources) => {
          let frames = []
          if (metro) {
            try {
              frames = await resolveSource(metro, stacks, debugSources)
            } catch (e) {
              frames = [{ error: e.message }]
            }
          }
          return { components: Array.isArray(components) ? components.slice(0, 16) : [], frames }
        }
        const pickEl = (el = {}) => ({ tag: el.tag, testID: el.testID ?? null, text: el.text, selector: el.selector, rect: el.rect, style: el.style })
        // Nhiều phần tử (overlay mới): elements[] mỗi phần tử có nhãn A–J và ghi chú riêng. Overlay cũ gửi element/components/stacks đơn.
        let elements = []
        if (Array.isArray(b.elements)) {
          const used = new Set()
          const list = []
          for (const [i, x] of b.elements.slice(0, MAX_ELEMENTS).entries()) {
            if (!x || typeof x !== 'object' || !x.element) continue
            let ref = typeof x.ref === 'string' && /^[A-J]$/.test(x.ref) && !used.has(x.ref) ? x.ref : null
            if (!ref) ref = REFS.find((r) => !used.has(r)) || String(i + 1)
            used.add(ref)
            const note = typeof x.note === 'string' && x.note.trim() ? x.note.trim().slice(0, 1000) : null
            list.push({ ref, note, x })
          }
          // Symbolicate song song: mỗi lần có timeout 5 s, chạy nối tiếp thì Metro treo làm 10 phần tử chờ ~50 s.
          const sources = await Promise.all(list.map(({ x }) => sourceOf(x.components, x.stacks, x.debugSources)))
          elements = list.map(({ ref, note, x }, i) => ({ ref, note, element: pickEl(x.element), source: sources[i] }))
        } else if (b.element) {
          elements = [{ ref: 'A', note: null, element: pickEl(b.element), source: await sourceOf(b.components, b.stacks, b.debugSources) }]
        }
        const note = typeof b.note === 'string' ? b.note.slice(0, 4000) : ''
        if (!note.trim() && !elements.some((x) => x.note) && !images.length) return json(res, 400, { error: 'note required' })
        if (images.length && !makeRoomForImages(images.reduce((n, g) => n + g.bytes, 0))) return json(res, 413, { error: 'image memory full; wait for the agent to answer pending messages' })
        const item = {
          id: newId(), createdAt: new Date().toISOString(), status: 'queued',
          url: b.url || null, origin: pageOrigin, viewport: b.viewport || null, note,
          // Ngôn ngữ giao diện overlay (vi|en): gợi ý cho agent trả lời đúng ngôn ngữ khi ghi chú quá ngắn để đoán.
          lang: b.lang === 'vi' || b.lang === 'en' ? b.lang : null,
        }
        // 0 hoặc 1 phần tử: giữ element/source top-level như bản cũ (agent/MCP cũ vẫn đọc được).
        // Từ 2 phần tử: bỏ top-level để agent cũ không lặng lẽ bỏ qua B, C…
        if (elements.length <= 1) {
          item.element = elements[0]?.element || pickEl()
          item.source = elements[0]?.source || { components: [], frames: [] }
        }
        item.elements = elements
        if (images.length) item.images = images
        return json(res, 200, enqueue(item))
      }

      // Ảnh của một tin (overlay hiện lại thumbnail sau khi tải lại trang).
      if (req.method === 'GET' && p === '/api/image') {
        const it = items.get(url.searchParams.get('id') || '')
        if (!it || (scope && it.origin !== scope)) return json(res, 404, { error: 'item not found' })
        const g = (it.images || []).find((x) => x.n === +url.searchParams.get('n'))
        if (!g) return json(res, 404, { error: 'image not found' })
        if (!g.data) return json(res, 410, { error: 'image dropped from memory' })
        res.writeHead(200, { 'content-type': g.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' })
        return res.end(Buffer.from(g.data, 'base64'))
      }

      if (req.method === 'GET' && p === '/api/poll') {
        const originFilter = url.searchParams.get('origin') || ''
        const timeout = Math.min(Math.max(+url.searchParams.get('timeout') || 600000, 0), 3600000)
        const who = String(url.searchParams.get('who') || '').slice(0, 200)
        const canAck = url.searchParams.get('ack') === '1'
        touchLoop(who, originFilter)
        const list = takeFor(originFilter)
        if (list.length) return deliver(res, list, who, canAck)
        // remind=1: client biết xử lý `unanswered`. Client bản cũ (MCP còn chạy từ trước) sẽ poll lại ngay và nuốt lời nhắc,
        // trong khi trang lại báo "đã nhắc": chỉ nhắc client khai báo hỗ trợ.
        const un = url.searchParams.get('remind') === '1' ? unansweredFor(who, originFilter) : []
        if (un.length) {
          un.forEach(remind)
          return json(res, 200, { status: 'unanswered', count: 0, items: [], unanswered: un.map((i) => ({ id: i.id, url: i.url, origin: i.origin, note: i.note, lang: i.lang ?? null, createdAt: i.createdAt, images: i.images?.length || 0 })) })
        }
        const w = { res, origin: originFilter, who, canAck, since: new Date().toISOString() }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          json(res, 200, { status: 'timeout', count: 0, items: [] })
          presence()
        }, timeout)
        waiters.push(w)
        res.on('close', () => {
          const i = waiters.indexOf(w)
          if (i >= 0) {
            // Poller ngắt kết nối khi chưa được trả lời (bị hủy/kill, không phải hết hạn hay nhận tin): agent đã rời vòng.
            waiters.splice(i, 1)
            clearTimeout(w.timer)
            endLoop(w.who)
            presence()
          }
        })
        presence()
        return
      }

      // Agent xác nhận đã nhận tin (poll của CLI/MCP tự gọi). Ack muộn sau khi tin bị trả về hàng đợi vẫn được nhận.
      if (req.method === 'POST' && p === '/api/ack') {
        const b = await readBody(req)
        const it = typeof b.id === 'string' ? items.get(b.id) : null
        if (!it) return json(res, 404, { error: 'unknown id' })
        if (it.status === 'queued') {
          const qi = queue.indexOf(it)
          if (qi >= 0) queue.splice(qi, 1)
        }
        // Ack muộn từ poller CŨ khi tin đã được giao lại cho poller khác: bỏ qua, không hủy hẹn giờ ack/trạng thái của poller hiện tại.
        const who = String(b.who || '').slice(0, 200)
        if (it.status === 'delivered' && who && it.deliveredTo?.who && it.deliveredTo.who !== who) return json(res, 200, { ok: true, status: it.status, stale: true })
        touchLoop(who, it.origin)
        if (it.status === 'queued' || it.status === 'delivered') {
          clearAck(it.id)
          it.status = 'received'
          it.receivedBy = String(b.who || '').slice(0, 200)
          it.receivedAt = Date.now()
          it.unacked = 0
          if (!it.deliveredTo) it.deliveredTo = { who: it.receivedBy, at: new Date().toISOString() }
          setStatus(it.id, 'received')
          armReceived(it)
        }
        return json(res, 200, { ok: true, status: it.status })
      }

      if (req.method === 'POST' && p === '/api/reply') {
        const b = await readBody(req)
        if (!b.text || typeof b.text !== 'string') return json(res, 400, { error: 'text required' })
        const it = b.id ? items.get(b.id) : null
        if (b.id && !it) return json(res, 404, { error: 'unknown id' })
        if (it) {
          it.status = 'replied'
          clearAck(it.id)
          clearReceived(it.id)
          const qi = queue.indexOf(it) // ack timer có thể đã trả tin về hàng đợi: gỡ ra để không giao lại tin đã xong
          if (qi >= 0) queue.splice(qi, 1)
        }
        // Có id: theo origin của yêu cầu. Không id: theo origin agent khai báo (hợp lệ mới nhận), nếu không thì phát cho mọi site.
        const replyOrigin = it ? it.origin : typeof b.origin === 'string' && (ORIGIN_OK.test(b.origin) || allow.has(b.origin)) ? b.origin : ''
        touchLoop(String(b.who || '').slice(0, 200), replyOrigin)
        // Tin tiến độ (không id) cho thấy agent còn sống: gia hạn hẹn giờ `received` của các tin cùng origin, và cứu tin đã `expired` nhầm.
        if (!it) {
          for (const x of items.values()) {
            if (replyOrigin && x.origin !== replyOrigin) continue
            if (x.status === 'expired' && replyOrigin) { x.status = 'received'; setStatus(x.id, 'received') }
            if (x.status === 'received') armReceived(x)
          }
        }
        pushEntry({ id: 'msg_' + ++seq, ts: new Date().toISOString(), role: 'agent', text: b.text.slice(0, 4000), itemId: b.id || null, origin: replyOrigin })
        if (it) setStatus(b.id, 'replied')
        return json(res, 200, { ok: true })
      }

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.uifbScope = scope
        res.uifbNonce = nonce
        res.write(`data: ${JSON.stringify(scope ? scopedPresence(scope) : presenceState())}\n\n`)
        sse.add(res)
        // Origin của trang mở luồng (trình duyệt luôn gửi với EventSource khác origin): biết trang nào đang mở để hiện thẻ xin quyền.
        const po = !scope && origin && ORIGIN_OK.test(origin) ? origin : ''
        if (po) pages.set(po, (pages.get(po) || 0) + 1)
        // Heartbeat cũng kiểm lại allow, để luồng site im lặng vẫn bị cắt khi site bị gỡ/hết hạn.
        const hb = setInterval(() => {
          if (scope && !scopeLive(res)) { sse.delete(res); res.end(); return }
          res.write(': hb\n\n')
        }, 15000)
        res.on('close', () => {
          sse.delete(res)
          clearInterval(hb)
          if (po) { const n = (pages.get(po) || 1) - 1; if (n > 0) pages.set(po, n); else pages.delete(po) }
        })
        return
      }

      return json(res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal error' })
    }
  })

  return {
    token,
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(server.address().port))
      }),
    close: () =>
      new Promise((resolve) => {
        for (const w of waiters) clearTimeout(w.timer)
        for (const pm of perms.values()) clearTimeout(pm.timer)
        for (const t of ackTimers.values()) clearTimeout(t)
        ackTimers.clear()
        for (const t of receivedTimers.values()) clearTimeout(t)
        receivedTimers.clear()
        for (const r of sse) r.end()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
    _queue: queue,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +process.env.UIFB_PORT || DEFAULT_PORT
  const b = createBridge({ port })
  sweepImages(3600000) // ảnh tạm của phiên bridge trước: tin đã không còn trong bộ nhớ
  b.listen()
    .then((p) => {
      fs.writeFileSync(path.join(stateDir(), 'server.json'), JSON.stringify({ port: p, pid: process.pid }))
      console.log(`ui-feedback listening on http://127.0.0.1:${p}`)
    })
    .catch((e) => {
      console.error('listen failed:', e.message)
      process.exit(1)
    })
  const bye = () => b.close().then(() => process.exit(0))
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
