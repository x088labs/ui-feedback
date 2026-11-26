// Ảnh dán vào khung chat: kiểm tra đầu vào, lưu trong RAM có trần, lịch sử/SSE không mang dữ liệu ảnh,
// /api/image, gửi lại, MCP trả khối image, CLI ghi file tạm và bridge dọn khi bỏ tin.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBridge } from '../bridge/server.mjs'
import { allowOrigin, listAllowed, pairKey } from '../bridge/remote.mjs'
import { parseImages, sniff, saveImages, removeImages, sweepImages, imageFile, MAX_IMAGES, MAX_IMAGE_BYTES } from '../bridge/images.mjs'
import { formatItem, formatUnanswered } from '../bridge/client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'http://localhost:8091'
// PNG 1x1 hợp lệ.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64')
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

async function start(opts = {}) {
  const dir = tmp('uifb-img-')
  const imgDir = path.join(dir, 'img')
  const b = createBridge({ port: 0, dir, imgDir, ...opts })
  const base = `http://127.0.0.1:${await b.listen()}`
  const H = { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' }
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const send = (body) => post('/api/feedback', { url: ORIGIN + '/', ...body })
  const history = async () => (await (await fetch(base + '/api/history?origin=' + encodeURIComponent(ORIGIN), { headers: H })).json()).entries
  const pollOnce = async () => (await fetch(base + '/api/poll?timeout=2000&origin=' + encodeURIComponent(ORIGIN), { headers: H })).json()
  return { b, base, H, dir, imgDir, post, send, history, pollOnce, stop: async () => { await b.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('sniff/parseImages: nhận png/jpeg theo magic bytes, từ chối sai định dạng, base64 hỏng, quá số lượng, quá lớn', () => {
  assert.equal(sniff(Buffer.from(PNG, 'base64')), 'image/png')
  assert.equal(sniff(Buffer.from(JPG, 'base64')), 'image/jpeg')
  assert.equal(sniff(Buffer.from('<svg/>')), null)
  const [g] = parseImages([{ data: 'data:image/png;base64,' + PNG, mime: 'image/gif', w: 1, h: 1 }])
  assert.deepEqual({ n: g.n, mime: g.mime, w: g.w, h: g.h }, { n: 1, mime: 'image/png', w: 1, h: 1 }) // mime theo nội dung, không theo khai báo
  assert.deepEqual(parseImages(undefined), [])
  assert.throws(() => parseImages('x'), { status: 400 })
  assert.throws(() => parseImages([{ data: Buffer.from('<svg onload=alert(1)>').toString('base64') }]), /not a png/)
  assert.throws(() => parseImages([{ data: 'không phải base64!' }]), /invalid base64/)
  assert.throws(() => parseImages(Array(MAX_IMAGES + 1).fill({ data: PNG })), /at most/)
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1); Buffer.from(PNG, 'base64').copy(big)
  assert.throws(() => parseImages([{ data: big.toString('base64') }]), { status: 413 })
})

test('bridge: tin có ảnh (kể cả chỉ có ảnh), lịch sử chỉ có metadata, /api/image trả đúng byte, poll mang dữ liệu', async () => {
  const s = await start()
  try {
    assert.equal((await s.send({ note: '' })).status, 400) // không chữ, không phần tử, không ảnh
    assert.equal((await s.send({ note: '', images: [{ data: Buffer.from('GIF').toString('base64') }] })).status, 400)
    const r = await s.send({ note: '', images: [{ data: PNG, w: 1, h: 1 }, { data: JPG }] })
    assert.equal(r.status, 200)
    const { id } = await r.json()
    const [e] = await s.history()
    assert.deepEqual(e.images.map((g) => [g.n, g.mime]), [[1, 'image/png'], [2, 'image/jpeg']])
    assert.ok(!JSON.stringify(e).includes(PNG.slice(0, 40)), 'lịch sử/SSE không mang dữ liệu ảnh')
    const img = await fetch(`${s.base}/api/image?id=${id}&n=1`, { headers: s.H })
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(PNG, 'base64'))
    assert.equal((await fetch(`${s.base}/api/image?id=${id}&n=9`, { headers: s.H })).status, 404)
    assert.equal((await fetch(`${s.base}/api/image?id=${id}&n=1`)).status, 401)
    const got = await s.pollOnce()
    assert.equal(got.items[0].images[0].data, PNG)
  } finally { await s.stop() }
})

test('bridge: body /api/feedback được nới cho ảnh, các route khác vẫn giới hạn 256 KB', async () => {
  const s = await start()
  try {
    assert.equal((await s.send({ note: 'x'.repeat(300 * 1024) })).status, 200)
    const r = await s.post('/api/feedback/resend', { id: 'x'.repeat(300 * 1024) }).catch(() => ({ status: 'reset' }))
    assert.ok(r.status === 413 || r.status === 'reset')
  } finally { await s.stop() }
})

test('bridge: vượt trần bộ nhớ ảnh thì bỏ ảnh của tin đã trả lời (xóa file tạm), còn tin đang chờ thì từ chối 413', async () => {
  const one = Buffer.from(PNG, 'base64').length
  const s = await start({ imageTotal: one * 2 })
  try {
    const a = (await (await s.send({ note: 'a', images: [{ data: PNG }] })).json()).id
    await s.pollOnce()
    await s.post('/api/reply', { id: a, text: 'xong' })
    fs.mkdirSync(s.imgDir, { recursive: true })
    fs.writeFileSync(path.join(s.imgDir, a + '-1.png'), 'x') // như CLI đã ghi
    await s.send({ note: 'b', images: [{ data: PNG }] })
    assert.equal((await s.send({ note: 'c', images: [{ data: PNG }] })).status, 200) // chỗ của a được giải phóng
    assert.ok(!fs.existsSync(path.join(s.imgDir, a + '-1.png')))
    assert.equal((await fetch(`${s.base}/api/image?id=${a}&n=1`, { headers: s.H })).status, 410)
    assert.equal((await s.history()).find((e) => e.id === a).imagesEvicted, true)
    assert.equal((await s.post('/api/feedback/resend', { id: a })).status, 410)
    assert.equal((await s.send({ note: 'd', images: [{ data: PNG }] })).status, 413) // b, c chưa trả lời
  } finally { await s.stop() }
})

test('bridge: gửi lại tin đã trả lời khi bộ nhớ ảnh đầy: bản gửi lại vẫn mang ảnh dù ảnh của tin gốc bị bỏ để lấy chỗ', async () => {
  const one = Buffer.from(PNG, 'base64').length
  const s = await start({ imageTotal: one * 2 })
  try {
    const a = (await (await s.send({ note: 'a', images: [{ data: PNG }] })).json()).id
    await s.pollOnce()
    await s.post('/api/reply', { id: a, text: 'xong' })
    await s.send({ note: 'b', images: [{ data: PNG }] }) // đang chờ: bộ nhớ đầy
    const r = await s.post('/api/feedback/resend', { id: a })
    assert.equal(r.status, 200)
    const again = (await r.json()).id
    assert.equal((await fetch(`${s.base}/api/image?id=${again}&n=1`, { headers: s.H })).status, 200)
    assert.equal((await fetch(`${s.base}/api/image?id=${a}&n=1`, { headers: s.H })).status, 410) // tin gốc nhường chỗ
    const got = await s.pollOnce()
    assert.equal(got.items.find((x) => x.id === again).images[0].data, PNG)
  } finally { await s.stop() }
})

test('bridge: handshake báo hỗ trợ ảnh; site ngoài localhost chỉ đọc được ảnh của chính nó', async () => {
  const s = await start()
  const SITE = 'https://qa.example.com'
  try {
    const local = await (await fetch(s.base + '/api/handshake', { headers: { origin: ORIGIN } })).json()
    assert.equal(local.images, true)
    allowOrigin(s.dir, SITE)
    const nonce = listAllowed(s.dir).find((x) => x.origin === SITE).nonce
    const site = await (await fetch(s.base + '/api/handshake?key=' + pairKey(s.b.token, SITE, nonce), { headers: { origin: SITE } })).json()
    assert.equal(site.images, true)
    const SH = { authorization: 'Bearer ' + site.token, 'content-type': 'application/json', origin: SITE }
    const mine = (await (await fetch(s.base + '/api/feedback', { method: 'POST', headers: SH, body: JSON.stringify({ note: 'x', url: SITE + '/', images: [{ data: PNG }] }) })).json()).id
    const theirs = (await (await s.send({ note: 'local', images: [{ data: PNG }] })).json()).id
    assert.equal((await fetch(`${s.base}/api/image?id=${mine}&n=1`, { headers: SH })).status, 200)
    assert.equal((await fetch(`${s.base}/api/image?id=${theirs}&n=1`, { headers: SH })).status, 404)
  } finally { await s.stop() }
})

test('bridge: gửi lại giữ ảnh', async () => {
  const s = await start()
  try {
    const id = (await (await s.send({ note: 'xem', images: [{ data: PNG }] })).json()).id
    const again = (await (await s.post('/api/feedback/resend', { id })).json()).id
    assert.equal((await fetch(`${s.base}/api/image?id=${again}&n=1`, { headers: s.H })).status, 200)
    const got = await s.pollOnce()
    assert.equal(got.items.find((x) => x.id === again).images[0].data, PNG)
  } finally { await s.stop() }
})

test('formatItem: liệt kê ảnh; có path thì in đường dẫn, có data thì báo khối image, bị bỏ thì báo không còn', () => {
  const g = { n: 1, mime: 'image/png', w: 10, h: 20, bytes: 5 }
  assert.match(formatItem({ id: 'fb_1', note: 'x', images: [{ ...g, data: PNG }] }), /^images: 1 attached .*image blocks.*\n {2}- \[img1\] 10x20 png$/m)
  assert.match(formatItem({ id: 'fb_1', note: 'x', images: [{ ...g, data: PNG, path: '/t/fb_1-1.png' }] }), /open each file[\s\S]*\[img1\] 10x20 png {2}\/t\/fb_1-1\.png/)
  assert.match(formatItem({ id: 'fb_1', note: 'x', images: [g] }), /dropped from memory/)
  assert.doesNotMatch(formatItem({ id: 'fb_1', note: 'x' }), /images:/)
  assert.match(formatUnanswered({ unanswered: [{ id: 'fb_1', note: 'x', images: 2 }] }), /^images: 2/m)
})

test('saveImages/removeImages/sweepImages: ghi file theo id tin, xóa theo id, dọn file cũ', () => {
  const dir = tmp('uifb-imgdir-')
  try {
    const it = saveImages({ id: 'fb_01_ab', images: [{ n: 1, mime: 'image/png', data: PNG }, { n: 2, mime: 'image/jpeg', data: JPG }] }, dir)
    assert.equal(it.images[0].path, imageFile('fb_01_ab', it.images[0], dir))
    assert.ok(it.images[1].path.endsWith('fb_01_ab-2.jpg'))
    assert.deepEqual(fs.readFileSync(it.images[0].path), Buffer.from(PNG, 'base64'))
    fs.writeFileSync(path.join(dir, 'fb_02_cd-1.png'), 'x')
    removeImages('fb_01_ab', dir)
    assert.deepEqual(fs.readdirSync(dir), ['fb_02_cd-1.png'])
    const old = new Date(Date.now() - 2 * 3600000)
    fs.utimesSync(path.join(dir, 'fb_02_cd-1.png'), old, old)
    sweepImages(3600000, dir)
    assert.deepEqual(fs.readdirSync(dir), [])
    // Không ghi được (đường dẫn là một file): không ném lỗi, ảnh mang `error`, formatItem báo thay vì làm mất phần chữ.
    const blocker = path.join(dir, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const bad = saveImages({ id: 'fb_03', note: 'chữ vẫn còn', images: [{ n: 1, mime: 'image/png', data: PNG }] }, blocker)
    assert.ok(bad.images[0].error && !bad.images[0].path)
    const out = formatItem(bad)
    assert.match(out, /note: chữ vẫn còn/)
    assert.match(out, /open each file[\s\S]*\[img1\] png {2}\(could not save the file: \w+\)/)
    // strip: bỏ base64 sau khi ghi (output --json)
    const st = saveImages({ id: 'fb_04', images: [{ n: 1, mime: 'image/png', data: PNG }] }, dir, { strip: true })
    assert.ok(st.images[0].path && !('data' in st.images[0]))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('MCP: poll trả khối text rồi từng khối image có nhãn', async () => {
  const s = await start()
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
    env: { ...process.env, UIFB_HOME: s.dir, UIFB_URL: s.base, UIFB_AGENT_PID: '0' }, stdio: ['pipe', 'pipe', 'inherit'],
  })
  try {
    const id = (await (await s.send({ note: 'xem [img1]', images: [{ data: PNG }] })).json()).id
    const line = new Promise((resolve) => readline.createInterface({ input: child.stdout }).once('line', resolve))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tl_ui_feedback_poll', arguments: { origin: ORIGIN, timeout_seconds: 5 } } }) + '\n')
    const { content } = JSON.parse(await line).result
    assert.match(content[0].text, /images: 1 attached .*image blocks/)
    assert.deepEqual(content.slice(1), [{ type: 'text', text: `${id} [img1]:` }, { type: 'image', data: PNG, mimeType: 'image/png' }])
  } finally { child.kill(); await s.stop() }
})

test('CLI poll: ghi ảnh ra thư mục tạm và in đường dẫn; bridge xóa file khi xóa lịch sử', async () => {
  const s = await start()
  try {
    const id = (await (await s.send({ note: 'xem', images: [{ data: PNG }] })).json()).id
    // spawn bất đồng bộ: bridge chạy trong tiến trình test, spawnSync sẽ chặn nó.
    const c = spawn(process.execPath, [path.join(ROOT, 'bridge', 'cli.mjs'), 'poll', '--origin', ORIGIN, '--timeout-ms', '3000'], {
      env: { ...process.env, UIFB_HOME: s.dir, UIFB_URL: s.base, UIFB_IMG_DIR: s.imgDir, UIFB_AGENT_PID: '0' },
    })
    const r = { stdout: '', stderr: '' }
    c.stdout.on('data', (d) => (r.stdout += d))
    c.stderr.on('data', (d) => (r.stderr += d))
    r.status = await new Promise((resolve) => c.on('close', resolve))
    assert.equal(r.status, 0, r.stderr)
    const file = path.join(s.imgDir, id + '-1.png')
    assert.ok(r.stdout.includes(file), r.stdout)
    assert.deepEqual(fs.readFileSync(file), Buffer.from(PNG, 'base64'))
    await s.post('/api/reply', { id, text: 'xong' })
    await fetch(s.base + '/api/history/clear?origin=' + encodeURIComponent(ORIGIN), { method: 'POST', headers: s.H })
    assert.ok(!fs.existsSync(file))
  } finally { await s.stop() }
})

test('CLI poll --json: ghi ảnh ra file, JSON có path và không có base64', async () => {
  const s = await start()
  try {
    const id = (await (await s.send({ note: 'xem', images: [{ data: PNG }] })).json()).id
    const c = spawn(process.execPath, [path.join(ROOT, 'bridge', 'cli.mjs'), 'poll', '--origin', ORIGIN, '--timeout-ms', '3000', '--json'], {
      env: { ...process.env, UIFB_HOME: s.dir, UIFB_URL: s.base, UIFB_IMG_DIR: s.imgDir, UIFB_AGENT_PID: '0' },
    })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    assert.equal(await new Promise((resolve) => c.on('close', resolve)), 0)
    const g = JSON.parse(out).items.find((x) => x.id === id).images[0]
    assert.equal(g.path, path.join(s.imgDir, id + '-1.png'))
    assert.ok(!('data' in g))
    assert.ok(!out.includes(PNG.slice(0, 40)))
  } finally { await s.stop() }
})
