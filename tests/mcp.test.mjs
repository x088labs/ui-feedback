// MCP server (stdio JSON-RPC) chạy thật như agent dùng, nối tới một bridge cách ly (cổng ngẫu nhiên, UIFB_HOME riêng).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBridge } from '../bridge/server.mjs'

const MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs')
const ORIGIN = 'http://localhost:8091'

async function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-mcp-'))
  const b = createBridge({ port: 0, dir, ...opts })
  const port = await b.listen()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, UIFB_HOME: dir, UIFB_URL: base, UIFB_AGENT_PID: '0', UIFB_LANG: 'vi' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const pending = new Map()
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  let n = 0
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++n
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = (name, args) => rpc('tools/call', { name, arguments: args })
  const H = { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' }
  return {
    b, base, child, rpc, call, H,
    stop: async () => {
      child.kill()
      await b.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('MCP: initialize thỏa thuận phiên bản, tools/list, ping, method lạ', async () => {
  const s = await setup()
  try {
    const known = await s.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    assert.equal(known.result.protocolVersion, '2025-03-26')
    assert.equal(known.result.serverInfo.name, 'ui-feedback')
    const unknown = await s.rpc('initialize', { protocolVersion: '1999-01-01' })
    assert.match(unknown.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/)
    assert.notEqual(unknown.result.protocolVersion, '1999-01-01')
    const tools = (await s.rpc('tools/list')).result.tools.map((t) => t.name)
    assert.deepEqual(tools.sort(), ['tl_ui_feedback_poll', 'tl_ui_feedback_reply'])
    assert.deepEqual((await s.rpc('ping')).result, {})
    assert.equal((await s.rpc('no/such')).error.code, -32601)
    assert.equal((await s.call('no_such_tool', {})).error.code, -32602)
  } finally { await s.stop() }
})

test('MCP: poll hết hạn trả câu ngắn; có phản hồi thì trả payload + next_step dùng tên tool; reply có id thì thành replied', async () => {
  const s = await setup()
  try {
    const idle = await s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 1 })
    assert.match(idle.result.content[0].text, /^timeout: .*tl_ui_feedback_poll/)

    const r = await fetch(s.base + '/api/feedback', { method: 'POST', headers: s.H, body: JSON.stringify({ note: 'nút lệch', url: ORIGIN + '/' }) })
    const { id } = await r.json()
    const got = (await s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 5 })).result.content[0].text
    assert.match(got, new RegExp(`# ${id}`))
    assert.match(got, /note: nút lệch/)
    assert.match(got, /next_step: .*`tl_ui_feedback_reply`/)
    assert.doesNotMatch(got, /--id/)

    const rep = await s.call('tl_ui_feedback_reply', { text: 'đã sửa\nhai dòng', id })
    assert.equal(rep.result.isError, undefined)
    const hist = await (await fetch(s.base + '/api/history?origin=' + encodeURIComponent(ORIGIN), { headers: s.H })).json()
    assert.equal(hist.entries.find((e) => e.id === id).status, 'replied')
    assert.equal(hist.entries.at(-1).text, 'đã sửa\nhai dòng')
  } finally { await s.stop() }
})

test('MCP: lỗi của tool trả isError, không làm sập server', async () => {
  const s = await setup()
  try {
    const bad = await s.call('tl_ui_feedback_reply', { text: 'x', id: 'fb_khong_co' })
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /404/)
    assert.deepEqual((await s.rpc('ping')).result, {})
  } finally { await s.stop() }
})

test('MCP: client đóng stdin thì server thoát (không để poll mồ côi nhận tin)', async () => {
  const s = await setup()
  try {
    s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 60 }) // poll đang chờ
    await new Promise((r) => setTimeout(r, 300))
    const exited = new Promise((r) => s.child.once('exit', (code) => r(code)))
    s.child.stdin.end()
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
    assert.equal(code, 0)
  } finally { await s.stop() }
})

test('MCP: client hủy tool call poll (notifications/cancelled) thì poll mồ côi không nhận tin; không trả lời request đã hủy', async () => {
  const s = await setup()
  try {
    let answered = false
    const p = s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 60 }).then(() => { answered = true })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal((await (await fetch(s.base + '/api/status', { headers: s.H })).json()).listening, 1)
    s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user interrupted' } }) + '\n')
    for (let i = 0; i < 40 && (await (await fetch(s.base + '/api/status', { headers: s.H })).json()).listening; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal((await (await fetch(s.base + '/api/status', { headers: s.H })).json()).listening, 0) // waiter đã gỡ
    const { id } = await (await fetch(s.base + '/api/feedback', { method: 'POST', headers: s.H, body: JSON.stringify({ note: 'mới', url: ORIGIN + '/' }) })).json()
    await new Promise((r) => setTimeout(r, 200))
    const hist = await (await fetch(s.base + '/api/history?origin=' + encodeURIComponent(ORIGIN), { headers: s.H })).json()
    assert.equal(hist.entries.find((e) => e.id === id).status, 'queued') // không bị poll đã hủy cướp mất
    // Poll mới nhận được tin; request đã hủy không bao giờ được trả lời.
    assert.match((await s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 5 })).result.content[0].text, new RegExp(`# ${id}`))
    assert.equal(answered, false)
    void p
  } finally { await s.stop() }
})

test('MCP: quay lại poll mà chưa reply tin đã nhận thì nhận lời nhắc dùng tên tool MCP', async () => {
  const s = await setup({ remindMs: 0 })
  try {
    const { id } = await (await fetch(s.base + '/api/feedback', { method: 'POST', headers: s.H, body: JSON.stringify({ note: 'thông báo này nghĩa là gì', url: ORIGIN + '/' }) })).json()
    await s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 5 })
    const t = (await s.call('tl_ui_feedback_poll', { origin: ORIGIN, timeout_seconds: 5 })).result.content[0].text
    assert.match(t, /^status: unanswered/)
    assert.match(t, new RegExp(`# ${id}`))
    assert.match(t, new RegExp('`tl_ui_feedback_reply` with `text` and `id: ' + id + '`'))
    assert.match(t, /never reaches the user/)
  } finally { await s.stop() }
})
