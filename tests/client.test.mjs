import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createBridge, VERSION } from '../bridge/server.mjs'
import { stopServe } from '../bridge/serve.mjs'

const A = 'http://localhost:51001'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-client-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

test('olderThan so x.y.z theo số; thiếu version coi là cũ hơn', async () => {
  const { olderThan } = await import('../bridge/client.mjs')
  assert.equal(olderThan('0.1.9', '0.1.10'), true)
  assert.equal(olderThan('0.2.0', '0.1.10'), false)
  assert.equal(olderThan('1.0.0', '1.0.0'), false)
  assert.equal(olderThan(undefined, '0.0.1'), true)
})

test('client.poll chia lần chờ dài thành nhiều request ngắn, vẫn trả timeout hoặc tin đến giữa chừng', async () => {
  const dir = tmp()
  const b = createBridge({ port: 0, dir })
  const port = await b.listen()
  const polls = []
  b.server.prependListener('request', (req) => { if (req.url.startsWith('/api/poll')) polls.push(new URL(req.url, 'http://x').searchParams.get('timeout')) })
  process.env.UIFB_HOME = dir
  process.env.UIFB_URL = `http://127.0.0.1:${port}`
  try {
    const { poll } = await import('../bridge/client.mjs')
    const t0 = Date.now()
    const r = await poll({ origin: A, timeoutMs: 700, chunkMs: 200 })
    assert.equal(r.count, 0)
    assert.ok(Date.now() - t0 >= 650, 'phải chờ đủ tổng thời gian')
    assert.ok(polls.length >= 3, `phải chia thành nhiều request, có ${polls.length}`)
    assert.ok(polls.every((t) => +t >= 1 && +t <= 200))

    // Tin đến sau request đầu tiên vẫn được nhận trong cùng một lần poll.
    const p = poll({ origin: A, timeoutMs: 2000, chunkMs: 200 })
    await sleep(350)
    const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: 'POST', headers: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x', url: A + '/' }),
    })
    assert.equal(res.status, 200)
    assert.equal((await p).count, 1)
  } finally {
    delete process.env.UIFB_HOME; delete process.env.UIFB_URL
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureServer dừng bridge bản cũ còn chạy nền rồi khởi động bản hiện tại', async () => {
  const dir = tmp()
  const port = await freePort()
  // Bridge "cũ": /health không có version (như các bản trước).
  const old = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ ok: true, name: 'ui-feedback', listening: 0 })) }).listen(${port}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise((r) => old.once('exit', () => r(true)))
  await new Promise((r) => old.stdout.once('data', r))
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port, pid: old.pid }))
  const saved = { home: process.env.UIFB_HOME, port: process.env.UIFB_PORT }
  process.env.UIFB_HOME = dir
  process.env.UIFB_PORT = String(port)
  let fresh = 0
  try {
    const { ensureServer } = await import('../bridge/client.mjs')
    const base = await ensureServer()
    const h = await (await fetch(base + '/health')).json()
    assert.equal(h.version, VERSION)
    fresh = h.pid
    assert.equal(await Promise.race([exited, sleep(2000).then(() => false)]), true, 'bridge cũ phải bị dừng')
  } finally {
    if (fresh) try { process.kill(fresh) } catch {}
    old.kill()
    if (saved.home == null) delete process.env.UIFB_HOME; else process.env.UIFB_HOME = saved.home
    if (saved.port == null) delete process.env.UIFB_PORT; else process.env.UIFB_PORT = saved.port
    await sleep(200)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stopServe giữ file trạng thái khi serve chỉ không trả lời kịp (timeout)', async () => {
  const dir = tmp()
  const hang = http.createServer(() => {}) // nhận request nhưng không bao giờ trả lời
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  const port = hang.address().port
  const file = path.join(dir, `serve-${port}.json`)
  fs.writeFileSync(file, JSON.stringify({ port, pid: process.pid, site: 'x', mode: 'static' }))
  try {
    await assert.rejects(stopServe(port, dir), /không trả lời/)
    assert.equal(fs.existsSync(file), true)
  } finally {
    hang.closeAllConnections(); hang.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
