import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from '../bridge/server.mjs'
import { allowOrigin, removeOrigin, listAllowed, pairKey, originToken, bookmarklet, normRemoteOrigin } from '../bridge/remote.mjs'

const SITE = 'https://qa.example.com'
const LOCAL = 'http://localhost:8091'

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-remote-'))
  const b = createBridge({ port: 0, dir })
  const port = await b.listen()
  const base = `http://127.0.0.1:${port}`
  const H = { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' }
  return {
    b, dir, base, H,
    handshake: (origin, key) => fetch(base + '/api/handshake' + (key ? '?key=' + key : ''), { headers: { origin } }),
    stop: async () => { await b.close(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}
// Khóa ghép cặp đúng như bookmarklet của `allow` (gắn nonce của lần allow).
const nonceOf = (dir, origin = SITE) => listAllowed(dir).find((x) => x.origin === origin)?.nonce || ''
const keyOf = (s, origin = SITE) => pairKey(s.b.token, origin, nonceOf(s.dir, origin))
const pair = async (s, origin = SITE) => (await (await s.handshake(origin, keyOf(s, origin))).json())
const asSite = (tok, origin = SITE) => ({ authorization: 'Bearer ' + tok, 'content-type': 'application/json', origin })

test('origin ngoài localhost chưa allow bị chặn; allow rồi vẫn cần khóa ghép cặp', async () => {
  const s = await start()
  try {
    assert.equal((await s.handshake(SITE)).status, 403)
    allowOrigin(s.dir, SITE)
    const noKey = await s.handshake(SITE)
    assert.equal(noKey.status, 403)
    assert.equal((await noKey.json()).pair, true)
    assert.equal(noKey.headers.get('access-control-allow-origin'), SITE) // trang đọc được lý do
    assert.equal((await s.handshake(SITE, 'sai')).status, 403)
    assert.equal((await s.handshake(SITE, pairKey(s.b.token, 'https://other.example.com'))).status, 403) // khóa của site khác
    const hs = await pair(s)
    assert.equal(hs.scoped, true)
    assert.notEqual(hs.token, s.b.token) // không bao giờ lộ token chính
    assert.equal(hs.token, originToken(s.b.token, SITE, nonceOf(s.dir)))
    // Site khác chưa allow vẫn bị chặn.
    assert.equal((await s.handshake('https://other.example.com', pairKey(s.b.token, 'https://other.example.com'))).status, 403)
  } finally { await s.stop() }
})

test('token của site chỉ mở API của trang, chỉ dùng được từ đúng origin đó', async () => {
  const s = await start()
  try {
    allowOrigin(s.dir, SITE)
    const { token } = await pair(s)
    for (const p of ['/api/status', '/api/poll?timeout=10', '/api/history']) {
      const r = await fetch(s.base + p, { headers: asSite(token) })
      assert.equal(r.status, p === '/api/history' ? 200 : 403, p)
    }
    for (const p of ['/api/reply', '/api/ack', '/api/permission/decide']) {
      assert.equal((await fetch(s.base + p, { method: 'POST', headers: asSite(token), body: '{}' })).status, 403, p)
    }
    // Token site dùng không có Origin (vd từ tiến trình local) hoặc từ localhost: không phải token chính.
    assert.equal((await fetch(s.base + '/api/status', { headers: { authorization: 'Bearer ' + token } })).status, 401)
    assert.equal((await fetch(s.base + '/api/history', { headers: asSite(token, LOCAL) })).status, 401)
    // Token chính gửi từ origin site: bị từ chối (site chỉ được dùng token riêng).
    assert.equal((await fetch(s.base + '/api/history', { headers: asSite(s.b.token) })).status, 401)
  } finally { await s.stop() }
})

test('site chỉ gửi feedback cho chính nó và chỉ thấy hội thoại của nó', async () => {
  const s = await start()
  try {
    allowOrigin(s.dir, SITE)
    const { token } = await pair(s)
    const post = (body) => fetch(s.base + '/api/feedback', { method: 'POST', headers: asSite(token), body: JSON.stringify(body) })
    assert.equal((await post({ note: 'x', url: LOCAL + '/' })).status, 400) // url của site khác
    const r = await post({ note: 'nút lệch', url: SITE + '/a', metroOrigin: 'http://localhost:8081', stacks: [{ comp: 'X', lines: ['at f (http://localhost:8081/x.js:1:1)'] }] })
    assert.equal(r.status, 200)
    const id = (await r.json()).id
    // Tin của localhost và tin agent không origin: site không thấy.
    await fetch(s.base + '/api/feedback', { method: 'POST', headers: s.H, body: JSON.stringify({ note: 'local', url: LOCAL + '/' }) })
    await fetch(s.base + '/api/reply', { method: 'POST', headers: s.H, body: JSON.stringify({ text: 'chung' }) })
    const h = await (await fetch(s.base + '/api/history?origin=' + encodeURIComponent(LOCAL), { headers: asSite(token) })).json()
    assert.deepEqual(h.entries.map((e) => e.text), ['nút lệch'])
    assert.deepEqual(h.permissions, [])
    // Agent nhận tin với origin của site, không có frame symbolicate (không gọi Metro).
    const got = await (await fetch(s.base + '/api/poll?timeout=100&origin=' + encodeURIComponent(SITE), { headers: s.H })).json()
    assert.equal(got.items[0].id, id)
    assert.equal(got.items[0].origin, SITE)
    assert.deepEqual(got.items[0].source.frames, [])
    // Reply không id với origin của site được nhận (không rơi về phát chung).
    await fetch(s.base + '/api/reply', { method: 'POST', headers: s.H, body: JSON.stringify({ text: 'đang sửa', origin: SITE }) })
    const h2 = await (await fetch(s.base + '/api/history', { headers: asSite(token) })).json()
    assert.deepEqual(h2.entries.map((e) => e.text), ['nút lệch', 'đang sửa'])
    // Không gửi lại được tin của site khác; xóa lịch sử chỉ xóa của site.
    const localId = h2.entries.length && (await (await fetch(s.base + '/api/history?origin=' + encodeURIComponent(LOCAL), { headers: s.H })).json()).entries.find((e) => e.text === 'local').id
    assert.equal((await fetch(s.base + '/api/feedback/resend', { method: 'POST', headers: asSite(token), body: JSON.stringify({ id: localId }) })).status, 404)
    await fetch(s.base + '/api/history/clear', { method: 'POST', headers: asSite(token) })
    const all = await (await fetch(s.base + '/api/history', { headers: s.H })).json()
    assert.ok(all.entries.some((e) => e.text === 'local'))
    assert.ok(!all.entries.some((e) => e.origin === SITE))
  } finally { await s.stop() }
})

test('luồng SSE của site chỉ nhận sự kiện của nó', async () => {
  const s = await start()
  const ac = new AbortController()
  try {
    allowOrigin(s.dir, SITE)
    const hs = await pair(s)
    assert.equal((await fetch(s.base + '/api/events?sse=' + hs.sse, { headers: { origin: LOCAL } })).status, 401) // khóa SSE của site, origin khác
    const res = await fetch(s.base + '/api/events?sse=' + hs.sse, { headers: { origin: SITE }, signal: ac.signal })
    assert.equal(res.status, 200)
    const events = []
    ;(async () => {
      const rd = res.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await rd.read().catch(() => ({ done: true }))
        if (done) break
        for (const l of dec.decode(value).split('\n')) if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)))
      }
    })()
    await fetch(s.base + '/api/feedback', { method: 'POST', headers: s.H, body: JSON.stringify({ note: 'local', url: LOCAL + '/' }) })
    await fetch(s.base + '/api/reply', { method: 'POST', headers: s.H, body: JSON.stringify({ text: 'chung' }) })
    await fetch(s.base + '/api/feedback', { method: 'POST', headers: asSite(hs.token), body: JSON.stringify({ note: 'của site', url: SITE + '/' }) })
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'message'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(events[0].type, 'presence')
    assert.equal(events[0].any, false)
    const msgs = events.filter((e) => e.type === 'message').map((e) => e.entry.text)
    assert.deepEqual(msgs, ['của site'])
  } finally { ac.abort(); await s.stop() }
})

test('site ngoài localhost không bao giờ nhận thẻ xin quyền', async () => {
  const s = await start()
  try {
    allowOrigin(s.dir, SITE)
    await fetch(s.base + '/api/feedback', { method: 'POST', headers: s.H, body: JSON.stringify({ note: 'sửa', url: SITE + '/' }) })
    await (await fetch(s.base + '/api/poll?ack=1&timeout=200&who=' + encodeURIComponent('pid 1 @ F:/x'), { headers: s.H })).json()
    const r = await (await fetch(s.base + '/api/permission', { method: 'POST', headers: s.H, body: JSON.stringify({ tool: 'Bash', input: { command: 'npm test' }, cwd: 'F:/x', timeoutMs: 100 }) })).json()
    assert.equal(r.decision, 'none')
    assert.match(r.reason, /no active ui feedback/) // không tạo thẻ rồi hết hạn: trả về ngay
  } finally { await s.stop() }
})

test('allow: chỉ https ngoài localhost, hết hạn thì bị chặn, gỡ được', async () => {
  const s = await start()
  try {
    assert.throws(() => normRemoteOrigin('http://qa.example.com'))
    assert.throws(() => normRemoteOrigin('https://localhost:3000'))
    assert.equal(normRemoteOrigin('https://qa.example.com/a/b?x=1'), SITE)
    allowOrigin(s.dir, SITE, 0)
    assert.equal(listAllowed(s.dir)[0].until, null)
    assert.equal((await s.handshake(SITE, keyOf(s))).status, 200)
    // Hết hạn (sửa file trực tiếp; bridge đọc lại khi mtime đổi).
    fs.writeFileSync(path.join(s.dir, 'origins.json'), JSON.stringify([{ origin: SITE, until: new Date(Date.now() - 1000).toISOString() }]))
    const t = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(s.dir, 'origins.json'), t, t)
    assert.equal((await s.handshake(SITE, pairKey(s.b.token, SITE, 'x'))).status, 403)
    assert.deepEqual(listAllowed(s.dir), [])
    allowOrigin(s.dir, SITE)
    assert.equal(removeOrigin(s.dir, SITE + '/'), true)
    assert.equal(removeOrigin(s.dir, SITE), false)
  } finally { await s.stop() }
})

test('bookmarklet chứa bridge và khóa, không chứa token chính', () => {
  const key = pairKey('t'.repeat(48), SITE)
  const bm = bookmarklet('http://127.0.0.1:47831/', key)
  assert.match(bm, /^javascript:/)
  assert.ok(bm.includes('"http://127.0.0.1:47831"'))
  assert.ok(bm.includes(key))
  assert.ok(!bm.includes('t'.repeat(48)))
  assert.ok(bm.includes("+'/overlay.js'"))
  // Overlay đã nạp: bookmarklet không ghi khóa lên trang nữa.
  const win = { __UIFB_LOADED__: true }
  new Function('window', 'document', bm.slice('javascript:'.length))(win, {})
  assert.equal(win.__UIFB__, undefined)
})

test('gỡ rồi allow lại đổi khóa: bookmarklet và token cũ hết hiệu lực; allow lại khi còn hạn thì giữ khóa', async () => {
  const s = await start()
  try {
    allowOrigin(s.dir, SITE)
    const k1 = keyOf(s)
    const t1 = (await pair(s)).token
    allowOrigin(s.dir, SITE, 48) // gia hạn
    assert.equal(keyOf(s), k1)
    removeOrigin(s.dir, SITE)
    allowOrigin(s.dir, SITE)
    const t = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(s.dir, 'origins.json'), t, t) // chắc chắn mtime đổi
    assert.notEqual(keyOf(s), k1)
    assert.equal((await s.handshake(SITE, k1)).status, 403)
    assert.equal((await fetch(s.base + '/api/history', { headers: asSite(t1) })).status, 401)
    assert.equal((await s.handshake(SITE, keyOf(s))).status, 200)
  } finally { await s.stop() }
})

test('gỡ site thì luồng SSE đang mở của nó bị đóng', async () => {
  const s = await start()
  const ac = new AbortController()
  try {
    allowOrigin(s.dir, SITE)
    const hs = await pair(s)
    const res = await fetch(s.base + '/api/events?sse=' + hs.sse, { headers: { origin: SITE }, signal: ac.signal })
    assert.equal(res.status, 200)
    let closed = false
    const msgs = []
    ;(async () => {
      const rd = res.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await rd.read().catch(() => ({ done: true }))
        if (done) break
        for (const l of dec.decode(value).split('\n')) if (l.startsWith('data: ')) msgs.push(JSON.parse(l.slice(6)))
      }
      closed = true
    })()
    removeOrigin(s.dir, SITE)
    const t = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(s.dir, 'origins.json'), t, t)
    // Sự kiện tiếp theo cho site (reply có origin) không tới trang, luồng bị đóng.
    await fetch(s.base + '/api/reply', { method: 'POST', headers: s.H, body: JSON.stringify({ text: 'sau khi gỡ' }) })
    for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(closed, true)
    assert.ok(!msgs.some((e) => e.type === 'message'))
  } finally { ac.abort(); await s.stop() }
})
