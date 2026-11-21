import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from '../bridge/server.mjs'

const A = 'http://localhost:51001'

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-ack-'))
  const b = createBridge({ port: 0, dir, ...opts })
  const port = await b.listen()
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + b.token } }, (res) => {
        const c = []
        res.on('data', (d) => c.push(d))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || '{}') }))
      })
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  const status = async (id, origin = A) => (await call('GET', '/api/history?origin=' + encodeURIComponent(origin))).json.entries.find((e) => e.id === id)?.status
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return { call, status, sleep, stop: async () => { await b.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('ack chuyển delivered -> received và ghi lại poller', async () => {
  const t = await start({ ackMs: 0 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    const got = await t.call('GET', '/api/poll?ack=1&timeout=500&who=pid%201&origin=' + encodeURIComponent(A))
    assert.equal(got.json.items[0].deliveredTo.who, 'pid 1')
    assert.equal(await t.status(f.id), 'delivered')
    assert.equal((await t.call('GET', '/api/status')).json.pending[0].who, 'pid 1')
    assert.equal((await t.call('POST', '/api/ack', { id: f.id, who: 'pid 1' })).json.status, 'received')
    assert.equal(await t.status(f.id), 'received')
    await t.call('POST', '/api/reply', { text: 'ok', id: f.id })
    assert.equal(await t.status(f.id), 'replied')
    assert.equal((await t.call('POST', '/api/ack', { id: 'nope' })).status, 404)
  } finally { await t.stop() }
})

test('không ack trong hạn: tin về hàng đợi (unacked) rồi giao lại cho poller kế', async () => {
  const t = await start({ ackMs: 150 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.sleep(300)
    const e = (await t.call('GET', '/api/history?origin=' + encodeURIComponent(A))).json.entries[0]
    assert.equal(e.status, 'queued')
    assert.equal(e.unacked, 1)
    const again = await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    assert.equal(again.json.count, 1)
    assert.equal(again.json.items[0].id, f.id)
  } finally { await t.stop() }
})

test('ack kịp hạn thì không bị giao lại; ack muộn vẫn được nhận', async () => {
  const t = await start({ ackMs: 150 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.call('POST', '/api/ack', { id: f.id })
    await t.sleep(300)
    assert.equal(await t.status(f.id), 'received')
    // ack muộn: tin đã bị trả hàng đợi, sau đó mới ack
    const { json: g } = await t.call('POST', '/api/feedback', { note: 'y', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.sleep(300)
    assert.equal(await t.status(g.id), 'queued')
    await t.call('POST', '/api/ack', { id: g.id })
    assert.equal(await t.status(g.id), 'received')
    assert.equal((await t.call('GET', '/api/status')).json.queued, 0)
  } finally { await t.stop() }
})

test('client.poll từ chối khi có serve đang chạy mà thiếu origin', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-home-'))
  process.env.UIFB_HOME = home
  try {
    fs.writeFileSync(path.join(home, 'serve-9999.json'), JSON.stringify({ port: 9999, pid: process.pid, site: 'x', mode: 'proxy' }))
    const { poll } = await import('../bridge/client.mjs')
    await assert.rejects(poll({}), /missing origin.*9999/)
  } finally {
    delete process.env.UIFB_HOME
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('poller gọi thẳng /api/poll (không ack=1) coi như đã nhận, không bị giao lặp', async () => {
  const t = await start({ ackMs: 100 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    const got = await t.call('GET', '/api/poll?timeout=500&origin=' + encodeURIComponent(A))
    assert.equal(got.json.count, 1)
    assert.equal(await t.status(f.id), 'received')
    await t.sleep(300)
    assert.equal((await t.call('GET', '/api/poll?timeout=200&origin=' + encodeURIComponent(A))).json.count, 0)
    assert.equal(await t.status(f.id), 'received')
  } finally { await t.stop() }
})

test('reply sau khi ack hết hạn gỡ tin khỏi hàng đợi, không giao lại tin đã trả lời', async () => {
  const t = await start({ ackMs: 80 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.sleep(200) // hết hạn ack: tin về hàng đợi
    assert.equal(await t.status(f.id), 'queued')
    await t.call('POST', '/api/reply', { text: 'xong', id: f.id })
    assert.equal(await t.status(f.id), 'replied')
    assert.equal((await t.call('GET', '/api/poll?ack=1&timeout=200&origin=' + encodeURIComponent(A))).json.count, 0)
    assert.equal(await t.status(f.id), 'replied')
  } finally { await t.stop() }
})

test('xóa lịch sử một site không xóa tin origin rỗng dùng chung; ack xong thì unacked về 0', async () => {
  const t = await start({ ackMs: 80 })
  try {
    const B = 'http://localhost:2222'
    await t.call('POST', '/api/reply', { text: 'chung' }) // không id, không origin -> origin ''
    await t.call('POST', '/api/history/clear?origin=' + encodeURIComponent(A))
    const h = await t.call('GET', '/api/history?origin=' + encodeURIComponent(B))
    assert.equal(h.json.entries.filter((e) => e.text === 'chung').length, 1)
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.sleep(200)
    const q = (await t.call('GET', '/api/history?origin=' + encodeURIComponent(A))).json.entries.find((e) => e.id === f.id)
    assert.equal(q.unacked, 1)
    await t.call('POST', '/api/ack', { id: f.id, who: 'pid 1' })
    const r = (await t.call('GET', '/api/history?origin=' + encodeURIComponent(A))).json.entries.find((e) => e.id === f.id)
    assert.equal(r.status, 'received')
    assert.equal(r.unacked, 0)
  } finally { await t.stop() }
})

test('ack muộn của poller cũ không phá tin đã giao lại cho poller khác', async () => {
  const t = await start({ ackMs: 80 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    const q = '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A)
    await t.call('GET', q + '&who=' + encodeURIComponent('pid 1 @ F:/a'))
    await t.sleep(200) // ack của A trễ quá hạn: tin về hàng đợi
    await t.call('GET', q + '&who=' + encodeURIComponent('pid 2 @ F:/b')) // giao lại cho B
    assert.equal(await t.status(f.id), 'delivered')
    const late = await t.call('POST', '/api/ack', { id: f.id, who: 'pid 1 @ F:/a' }) // A ack muộn
    assert.equal(late.json.stale, true)
    assert.equal(await t.status(f.id), 'delivered') // vẫn thuộc B, hẹn giờ của B còn nguyên
    assert.equal((await t.call('POST', '/api/ack', { id: f.id, who: 'pid 2 @ F:/b' })).json.status, 'received')
  } finally { await t.stop() }
})

test('received mà agent không trả lời trong hạn: chuyển expired, trả lời muộn vẫn thành replied', async () => {
  const t = await start({ ackMs: 0, receivedMs: 100 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.call('POST', '/api/ack', { id: f.id })
    assert.equal(await t.status(f.id), 'received')
    await t.sleep(250)
    assert.equal(await t.status(f.id), 'expired')
    await t.call('POST', '/api/reply', { text: 'ok', id: f.id })
    assert.equal(await t.status(f.id), 'replied')
  } finally { await t.stop() }
})

test('trả lời kịp hạn thì không bị chuyển expired', async () => {
  const t = await start({ ackMs: 0, receivedMs: 100 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.call('POST', '/api/ack', { id: f.id })
    await t.call('POST', '/api/reply', { text: 'ok', id: f.id })
    await t.sleep(250)
    assert.equal(await t.status(f.id), 'replied')
  } finally { await t.stop() }
})

test('tin tiến độ không id gia hạn hẹn giờ received và cứu tin đã expired nhầm', async () => {
  const t = await start({ ackMs: 0, receivedMs: 200 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent(A))
    await t.call('POST', '/api/ack', { id: f.id })
    await t.sleep(120)
    await t.call('POST', '/api/reply', { text: 'đang làm', origin: A }) // gia hạn: hẹn giờ chạy lại từ đây
    await t.sleep(120)
    assert.equal(await t.status(f.id), 'received') // 240ms kể từ ack nhưng mới 120ms kể từ tin tiến độ
    await t.sleep(250)
    assert.equal(await t.status(f.id), 'expired')
    await t.call('POST', '/api/reply', { text: 'vẫn đang làm', origin: A }) // agent còn sống: cứu lại
    assert.equal(await t.status(f.id), 'received')
    await t.call('POST', '/api/reply', { text: 'xong', id: f.id })
    assert.equal(await t.status(f.id), 'replied')
  } finally { await t.stop() }
})

test('poller cùng phiên quay lại poll mà chưa reply tin đã nhận: trả lời nhắc unanswered một lần', async () => {
  const t = await start({ ackMs: 0, remindMs: 0 })
  try {
    const who = encodeURIComponent('pid 1 #agent=77 @ F:/x')
    const q = (w, ms = 200, extra = '&remind=1') => t.call('GET', `/api/poll?ack=1${extra}&timeout=${ms}&who=${w}&origin=` + encodeURIComponent(A))
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'nghĩa là gì', url: A + '/' })
    await q(who)
    await t.call('POST', '/api/ack', { id: f.id, who: 'pid 1 #agent=77 @ F:/x' })
    // Phiên khác (agent khác) poll: không bị nhắc tin của người khác.
    assert.equal((await q(encodeURIComponent('pid 9 #agent=88 @ F:/x'))).json.status, 'timeout')
    // Cùng agent (PID MCP khác, ví dụ CLI) quay lại poll: nhắc ngay.
    const r = await q(encodeURIComponent('pid 2 #agent=77 @ F:/y'), 5000)
    assert.equal(r.json.status, 'unanswered')
    assert.equal(r.json.count, 0)
    assert.deepEqual(r.json.unanswered.map((u) => [u.id, u.note]), [[f.id, 'nghĩa là gì']])
    const e = (await t.call('GET', '/api/history?origin=' + encodeURIComponent(A))).json.entries.find((x) => x.id === f.id)
    assert.equal(e.status, 'received')
    assert.equal(e.reminded, true)
    // Chỉ nhắc một lần: lần sau chờ như thường.
    assert.equal((await q(who)).json.status, 'timeout')
  } finally { await t.stop() }
})

test('chưa đủ remindMs kể từ lúc nhận thì không nhắc (agent poll nền trong lúc còn làm)', async () => {
  const t = await start({ ackMs: 0, remindMs: 60000 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?remind=1&timeout=200&who=pid%201&origin=' + encodeURIComponent(A))
    assert.equal(await t.status(f.id), 'received')
    assert.equal((await t.call('GET', '/api/poll?remind=1&timeout=200&who=pid%201&origin=' + encodeURIComponent(A))).json.status, 'timeout')
  } finally { await t.stop() }
})

test('client bản cũ (không gửi remind=1) không bao giờ nhận unanswered; tin không bị đánh dấu đã nhắc', async () => {
  const t = await start({ ackMs: 0, remindMs: 0 })
  try {
    const { json: f } = await t.call('POST', '/api/feedback', { note: 'x', url: A + '/' })
    await t.call('GET', '/api/poll?timeout=200&who=pid%201&origin=' + encodeURIComponent(A))
    assert.equal(await t.status(f.id), 'received')
    assert.equal((await t.call('GET', '/api/poll?timeout=200&who=pid%201&origin=' + encodeURIComponent(A))).json.status, 'timeout')
    const e = (await t.call('GET', '/api/history?origin=' + encodeURIComponent(A))).json.entries.find((x) => x.id === f.id)
    assert.equal(e.reminded, undefined)
  } finally { await t.stop() }
})
