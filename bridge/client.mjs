// Client dùng chung cho CLI và MCP: tự khởi động bridge nền, gọi API bằng token trong file.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, VERSION, stateDir, loadOrCreateToken, riskyReason } from './server.mjs'
import { listServes } from './serve.mjs'
import { agentPid } from './agentproc.mjs'
import { L } from './i18n.mjs'

const DENIED = 'The user denied this on the UI Feedback page.'

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')

export function baseUrl() {
  if (process.env.UIFB_URL) return process.env.UIFB_URL
  let port = +process.env.UIFB_PORT || DEFAULT_PORT
  try {
    port = JSON.parse(fs.readFileSync(path.join(stateDir(), 'server.json'), 'utf8')).port || port
  } catch {}
  return `http://127.0.0.1:${port}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// /health của bridge ui-feedback ở base, hoặc null nếu không có.
async function health(base) {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) })
    const j = r.ok ? await r.json() : null
    return j?.name === 'ui-feedback' ? j : null
  } catch {
    return null
  }
}

// So x.y.z. Bridge trước khi /health có version thì coi là cũ hơn.
export function olderThan(v, ref) {
  const a = String(v || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const b = String(ref).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0)
  return false
}

// Bridge chạy nền sống qua các lần nâng cấp, mà hợp đồng overlay ↔ bridge đổi giữa các bản (vd khóa SSE):
// gặp bản CŨ hơn thì dừng để khởi động bản này. Chỉ thay bản cũ hơn, để hai bản cài song song không giết nhau qua lại.
async function replaceStale(base, h) {
  let pid = h.pid
  if (!pid) try { pid = JSON.parse(fs.readFileSync(path.join(stateDir(), 'server.json'), 'utf8')).pid } catch {}
  if (!pid) return false
  try { process.kill(pid) } catch { return false }
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    if (!(await health(base))) return true
  }
  return false
}

export async function ensureServer() {
  const base = baseUrl()
  const h = await health(base)
  // UIFB_URL: bridge do người dùng chỉ định, không bao giờ dừng nó. Không dừng được bản cũ thì dùng tạm.
  if (h && (process.env.UIFB_URL || !olderThan(h.version, VERSION) || !(await replaceStale(base, h)))) return base
  if (process.env.UIFB_URL) throw new Error(L('bridge không chạy tại ', 'bridge is not running at ') + base)
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(150)
    const b = baseUrl()
    if (await health(b)) return b
  }
  throw new Error(L('không khởi động được bridge', 'could not start the bridge'))
}

// Bridge đã xác nhận sống trong tiến trình này: gọi thẳng, chỉ kiểm tra/khởi động lại khi kết nối lỗi.
let knownBase = null
export async function api(method, route, body, { signal } = {}) {
  const call = (base) => fetch(base + route, {
    method,
    headers: { authorization: 'Bearer ' + loadOrCreateToken(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  let r
  try {
    r = await call(knownBase || (knownBase = await ensureServer()))
  } catch (e) {
    if (signal?.aborted || !knownBase) throw e
    r = await call((knownBase = await ensureServer())) // bridge vừa tắt/đổi cổng: khởi động lại rồi thử một lần
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`bridge ${r.status}: ${j.error || 'error'}`)
  return j
}

export const ack = (id, who) => api('POST', '/api/ack', { id, who })
// "#agent=N" (nếu có) là PID tiến trình agent cha: server dùng nó để biết hook và poller thuộc cùng một phiên, bất kể cwd.
// Đặt #agent TRƯỚC cwd: server cắt `who` ở 200 ký tự, cwd dài sẽ làm mất phần đuôi.
export const pollerId = () => `pid ${process.pid}` + (agentPid() ? ` #agent=${agentPid()}` : '') + ` @ ${process.cwd()}`

// Có site đang chạy qua `serve` mà poll không lọc origin sẽ cướp tin của agent khác: bắt buộc khai origin.
// fetch của Node (undici) hủy request nếu 300 giây chưa có header, mà /api/poll chỉ gửi header khi có tin hoặc hết hạn:
// chia lần chờ dài thành các request ngắn hơn ngưỡng đó, gộp lại thành một lần poll với người gọi.
export const POLL_CHUNK_MS = 280000
const DEFAULT_POLL_MS = 600000 // trùng mặc định phía server

// signal: người gọi hủy (MCP notifications/cancelled) thì ngắt request đang chờ, để bridge gỡ waiter
// thay vì giao tin cho một lần poll không còn ai đọc kết quả.
export async function poll({ origin, timeoutMs, allowAny = false, chunkMs = POLL_CHUNK_MS, signal } = {}) {
  if (!origin && !allowAny) {
    const l = listServes()
    if (l.length) throw new Error(`missing origin. Sites running: ${l.map((s) => 'http://localhost:' + s.port).join(', ')}. Pass the origin of the site you handle (or --any / any: true to take every site).`)
  }
  const who = pollerId()
  const q = new URLSearchParams({ who, ack: '1', remind: '1' }) // ack=1: client này sẽ gọi /api/ack bên dưới; remind=1: hiểu `status: unanswered`
  if (origin) q.set('origin', origin)
  const end = Date.now() + Math.min(Math.max(timeoutMs ?? DEFAULT_POLL_MS, 0), 3600000)
  let r
  do {
    // Tối thiểu 1 ms: server hiểu timeout=0 là "dùng mặc định 10 phút".
    q.set('timeout', String(Math.max(Math.min(end - Date.now(), chunkMs), 1)))
    signal?.throwIfAborted()
    r = await api('GET', '/api/poll?' + q, null, { signal })
  } while (!r.count && r.status !== 'unanswered' && end - Date.now() > 50)
  if (signal?.aborted) return r // bị hủy đúng lúc nhận tin: không ack, để hẹn giờ ack trả tin về hàng đợi và giao lại
  // Nhận được tin ở đây là bằng chứng tiến trình agent đã cầm tin: báo lại để trang hiện "Agent đã đọc".
  await Promise.all((r.items || []).map((it) => ack(it.id, who).catch(() => {})))
  return r
}

// who: cho server biết phiên agent vẫn đang trong vòng UI feedback (để thẻ xin quyền tiếp tục hiện trên trang sau khi trả lời).
export const reply = (text, id, origin) => api('POST', '/api/reply', { text, id, origin, who: pollerId() })
export const status = () => api('GET', '/api/status')

// Phần mô tả một phần tử (selector, style, components, source). pad: thụt lề khi in trong danh sách nhiều phần tử.
function elementLines(element, source, pad = '') {
  const f = (source?.frames || []).filter((x) => x.file)
  return [
    element?.tag ? `element: <${(element.tag || '?').toLowerCase()}> text=${JSON.stringify(element?.text || '')}${element?.testID ? ` testID=${element.testID}` : ''}` : 'element: (free message, no element picked)',
    `selector: ${element?.selector || ''}`,
    `rect: ${JSON.stringify(element?.rect || {})}  style: ${JSON.stringify(element?.style || {})}`,
    `components: ${(source?.components || []).join(' > ')}`,
    `source (open these files to fix):`,
    ...(f.length ? f.map((x) => `  - ${x.element}${x.createdIn ? ' <- ' + x.createdIn : ''}  ${x.file}:${x.line}:${x.column}`) : ['  (no source file; use selector/text/components)']),
  ].map((l) => pad + l)
}

// Ảnh người dùng dán vào tin. Có `path` (CLI đã ghi ra thư mục tạm) thì in đường dẫn để agent mở; MCP gửi ảnh thành khối image ngay sau văn bản.
function imageLines(imgs) {
  if (!imgs?.length) return []
  const size = (g) => (g.w && g.h ? ` ${g.w}x${g.h}` : '') + ` ${String(g.mime || '').replace('image/', '')}`
  // CLI (đã thử ghi file: có path hoặc error) / MCP (còn data, gửi khối image) / ảnh đã bị bỏ khỏi bộ nhớ.
  const where = imgs.some((g) => g.path || g.error)
    ? 'open each file to see it'
    : imgs.some((g) => g.data) ? 'shown as image blocks after this text' : 'dropped from memory, not available'
  return [
    `images: ${imgs.length} attached by the user (${where}); [img1], [img2]... in the note refer to them.`,
    ...imgs.map((g) => `  - [img${g.n}]${size(g)}${g.path ? '  ' + g.path : g.error ? `  (could not save the file: ${g.error})` : ''}`),
  ]
}

export function formatItem(it) {
  const els = Array.isArray(it.elements) ? it.elements : []
  const head = [`# ${it.id}  ${it.url || ''}`, `note: ${it.note}`, ...(it.lang ? [`page_lang: ${it.lang}`] : []), ...imageLines(it.images)]
  // 0–1 phần tử không có ghi chú riêng: giữ nguyên định dạng cũ.
  if (els.length <= 1 && !els[0]?.note) return [...head, ...elementLines(it.element ?? els[0]?.element, it.source ?? els[0]?.source)].join('\n')
  return [
    ...head,
    `elements: ${els.length} picked. [A], [B]... in the note refer to the element with that ref; each element may carry its own note.`,
    ...els.flatMap((x) => ['', `## [${x.ref}]${x.note ? ' note: ' + x.note : ''}`, ...elementLines(x.element, x.source, '  ')]),
  ].join('\n')
}

// Lời nhắc khi poll trả `unanswered`: agent đã nhận các tin này nhưng chưa gửi câu trả lời cuối lên trang.
export function formatUnanswered(r, { mcp = false } = {}) {
  const replyCmd = (id) => mcp ? `\`tl_ui_feedback_reply\` with \`text\` and \`id: ${id}\`` : `\`tl-ui-feedback reply "<answer>" --id ${id}\``
  const pollCmd = mcp ? '`tl_ui_feedback_poll` again with the same `origin`' : '`tl-ui-feedback poll --origin <origin>` again'
  const list = r.unanswered || []
  return [
    `status: unanswered  count: ${list.length}`,
    '',
    'You received these items earlier but never sent the final reply, so the page still shows "Agent is working". Text you write in your terminal never reaches the user.',
    ...list.map((u) => `\n# ${u.id}  ${u.url || u.origin || ''}\nnote: ${u.note}` + (u.lang ? `\npage_lang: ${u.lang}` : '') + (u.images ? `\nimages: ${u.images} (sent with the original item)` : '')),
    '',
    `next_step: For each item: if you already handled or answered it, send that answer now with ${list.length === 1 ? replyCmd(list[0].id) : replyCmd('<id>')}. ` +
      `If you are still working on it, finish first (a short progress reply without id is fine), then send the final reply with its id. ${REPLY_LANG} Then run ${pollCmd}.`,
  ].join('\n')
}

// mcp: gợi ý cho agent dùng tool MCP (tham số là trường JSON, không có stdin/cờ dòng lệnh).
// Câu trả lời hiện cho người dùng trong khung chat: phải cùng ngôn ngữ với ghi chú của họ.
export const REPLY_LANG = "Write every reply in the language of the user's note (if the note is too short to tell, use `page_lang`)."
// Ghi chú dạng câu hỏi: agent hay trả lời ngay trong terminal rồi poll tiếp, trang kẹt ở "đang làm".
const REPLY_ONLY = 'A question also needs a reply with its `id`: text you write in your terminal never reaches the user.'

export function nextStep(count, { mcp = false } = {}) {
  if (mcp) {
    return count
      ? 'Fix the code for the feedback above, then call `tl_ui_feedback_reply` with `text` (what you changed, one point per line) and `id` for each item, then call `tl_ui_feedback_poll` again with the same `origin`. ' + REPLY_ONLY + ' ' + REPLY_LANG + ' Keep looping until the user says stop.'
      : 'No feedback yet. Call `tl_ui_feedback_poll` again with the same `origin`; the queue loses nothing.'
  }
  return count
    ? REPLY_LANG + ' Fix the code for the feedback above, then run `tl-ui-feedback reply "<what you changed>" --id <id>` for each item' +
      ' (multi-line text goes through stdin: `printf \'a\\nb\' | tl-ui-feedback reply - --id <id>`, PowerShell `"a`nb" | tl-ui-feedback reply - --id <id>`, because the Windows .cmd shim cuts arguments at newlines)' +
      ', then run `tl-ui-feedback poll --origin <origin>` again. ' + REPLY_ONLY + ' Keep looping until the user says stop.'
    : 'No feedback yet. Run `tl-ui-feedback poll --origin <origin>` again; the queue loses nothing.'
}

// Hook PermissionRequest (Claude Code và Codex dùng chung định dạng). Trả về JSON để in ra stdout, hoặc null = để agent hỏi như thường.
// Không tự khởi động bridge: bridge không chạy nghĩa là không có phiên UI nào để hỏi.
export async function permissionHook(input, { timeoutMs = 100000 } = {}) {
  const base = baseUrl()
  if (riskyReason(input.tool_name, input.tool_input, input.cwd)) return null // rủi ro (rm, git push...): luôn hỏi ở terminal
  if (!(await health(base))) return null
  const auth = { authorization: 'Bearer ' + loadOrCreateToken() }
  const session = String(input.session_id || '')
  const probe = await fetch(base + '/api/permission/probe?cwd=' + encodeURIComponent(input.cwd || '') + '&session=' + encodeURIComponent(session), { headers: auth, signal: AbortSignal.timeout(5000) }).then((x) => x.json()).catch(() => ({}))
  // Hook cài toàn cục nên chạy cho mọi phiên agent trên máy. Dò PID tiến trình tốn ~0,6s nên tránh tối đa:
  // - không có tin nào đang được xử lý, hoặc server đã biết PID của phiên này mà không khớp: thoát ngay;
  // - chưa biết PID (hook đầu tiên của phiên) mà có ứng viên: dò một lần rồi gửi kèm session_id để server nhớ.
  if (!probe.active && (probe.agent || !probe.candidates)) return null
  const agent = probe.agent || agentPid()
  let r
  try {
    r = await fetch(base + '/api/permission', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + loadOrCreateToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ tool: input.tool_name, input: input.tool_input, cwd: input.cwd, agent, session, who: pollerId(), timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10000),
    })
  } catch {
    return null
  }
  const j = await r.json().catch(() => ({}))
  if (j.decision === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  if (j.decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: j.message || DENIED } } }
  return null
}

