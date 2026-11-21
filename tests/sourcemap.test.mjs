import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lookup, normalizeSource, createSourceMapResolver, parseFrame, parseServerFrame, jsxSourcePositions } from '../bridge/sourcemap.mjs'

// Mã hóa VLQ để dựng source map thử: lines = [[ [genCol, src, srcLine, srcCol], ... ], ...] (giá trị tuyệt đối, 0-based).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const vlq = (n) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1
  let s = ''
  do { let d = v & 31; v >>>= 5; if (v) d |= 32; s += B64[d] } while (v)
  return s
}
function encode(lines) {
  let src = 0, sl = 0, sc = 0
  return lines.map((segs) => {
    let gc = 0
    return segs.map(([g, a, b, c]) => {
      const out = vlq(g - gc) + vlq(a - src) + vlq(b - sl) + vlq(c - sc)
      gc = g; src = a; sl = b; sc = c
      return out
    }).join(',')
  }).join(';')
}
const mapOf = (sources, lines, extra = {}) => ({ version: 3, sources, names: [], mappings: encode(lines), ...extra })

test('lookup: chọn đoạn gần nhất bên trái cột, dòng và cột trả về 1-based', () => {
  const m = mapOf(['a.tsx', 'b.tsx'], [[[0, 0, 0, 0]], [[2, 0, 4, 1], [10, 1, 7, 3]]])
  assert.deepEqual(lookup(m, 2, 5), { source: 'a.tsx', line: 5, column: 2 })
  assert.deepEqual(lookup(m, 2, 11), { source: 'b.tsx', line: 8, column: 4 })
  assert.deepEqual(lookup(m, 2, 99), { source: 'b.tsx', line: 8, column: 4 })
  assert.equal(lookup(m, 50, 1), null)
})

test('lookup: đúng qua nhiều checkpoint (trạng thái mang từ các dòng trước)', () => {
  const lines = []
  for (let i = 0; i < 1000; i++) lines.push([[0, i % 3, i, i % 7]])
  const m = mapOf(['x.ts', 'y.ts', 'z.ts'], lines)
  for (const l of [1, 128, 129, 300, 777, 1000]) {
    const i = l - 1
    assert.deepEqual(lookup(m, l, 1), { source: ['x.ts', 'y.ts', 'z.ts'][i % 3], line: i + 1, column: (i % 7) + 1 })
  }
})

test('lookup: index map (sections, kiểu Turbopack) và sourceRoot', () => {
  const m = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: mapOf(['lib.js'], [[[0, 0, 0, 0]]]) },
      { offset: { line: 10, column: 0 }, map: mapOf(['page.tsx'], [[[0, 0, 0, 0]], [[4, 0, 41, 8]]], { sourceRoot: 'src' }) },
    ],
  }
  assert.deepEqual(lookup(m, 12, 6), { source: 'src/page.tsx', line: 42, column: 9 })
  assert.equal(lookup(m, 1, 1).source, 'lib.js')
})

test('normalizeSource: turbopack, webpack, file://, tương đối theo URL map', () => {
  assert.equal(normalizeSource('turbopack:///[project]/apps/admin/src/app/page.tsx', 'http://localhost:3000/_next/x.js.map'), 'apps/admin/src/app/page.tsx')
  assert.equal(normalizeSource('webpack://_N_E/./src/Card.tsx?abc', 'http://localhost:3000/x.map'), 'src/Card.tsx')
  assert.equal(normalizeSource('Card.tsx', 'http://localhost:5173/src/components/Card.tsx?t=1'), '/src/components/Card.tsx')
  assert.equal(normalizeSource('/src/App.tsx', 'http://localhost:5173/src/App.tsx'), '/src/App.tsx')
  assert.match(normalizeSource(process.platform === 'win32' ? 'file:///C:/w/src/a.tsx' : 'file:///w/src/a.tsx', 'x'), /\/w\/src\/a\.tsx$/)
})

test('parseFrame: dòng stack V8 có và không có tên hàm', () => {
  assert.deepEqual(parseFrame('at Card (http://localhost:5173/src/Card.tsx?t=1:12:7)'), { methodName: 'Card', url: 'http://localhost:5173/src/Card.tsx?t=1', line: 12, column: 7 })
  assert.equal(parseFrame('at http://localhost:3000/_next/a.js:3:4').methodName, '')
  assert.equal(parseFrame('Error: react-stack-top-frame'), null)
})

// Dev server giả: Vite (map nhúng base64) và Next (file .map riêng, có sections).
function devServer() {
  const files = new Map()
  const calls = []
  const add = (u, body) => files.set(u, body)
  const fetchImpl = async (u) => {
    u = String(u)
    calls.push(u)
    const body = files.get(u)
    if (body == null) return { ok: false, status: 404, text: async () => 'nf' }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body }
  }
  return { add, fetchImpl, calls }
}
const inline = (map) => '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64')

const VITE = 'http://localhost:5173'
const viteStack = [{ comp: 'Card', lines: [
  'at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:200:3)',
  'at Card (http://localhost:5173/src/components/Card.tsx?t=1:3:5)',
] }]

test('resolver Vite: bỏ qua URL deps không tải, đọc map nhúng, trả đường dẫn /src/...', async () => {
  const d = devServer()
  d.add(VITE + '/src/components/Card.tsx?t=1', 'a\nb\nconst x = jsxDEV(...)\n' + inline(mapOf(['Card.tsx'], [[], [], [[0, 0, 0, 0], [4, 0, 11, 6]]])))
  const r = createSourceMapResolver({ fetchImpl: d.fetchImpl })
  const out = await r.resolve(VITE, viteStack)
  assert.deepEqual(out, [{ element: 'Card', createdIn: 'Card', file: '/src/components/Card.tsx', line: 12, column: 7 }])
  assert.ok(d.calls.every((u) => !u.includes('node_modules')), 'không tải deps')
  // Lần hai dùng cache, không tải lại.
  await r.resolve(VITE, viteStack)
  assert.equal(d.calls.length, 1)
})

test('resolver Next: file .map riêng có sections; bỏ frame runtime/node_modules trong cùng chunk', async () => {
  const d = devServer()
  const N = 'http://localhost:3000'
  const chunk = N + '/_next/static/chunks/app_page.js'
  d.add(chunk, 'x\n'.repeat(5) + '//# sourceMappingURL=app_page.js.map')
  d.add(chunk + '.map', JSON.stringify({
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: mapOf(['turbopack:///[project]/node_modules/react/x.js'], [[[0, 0, 0, 0]]]) },
      { offset: { line: 2, column: 0 }, map: mapOf(['turbopack:///[project]/apps/admin/src/app/page.tsx'], [[[0, 0, 20, 4]]]) },
    ],
  }))
  const r = createSourceMapResolver({ fetchImpl: d.fetchImpl })
  const out = await r.resolve(N, [{ comp: 'Page', lines: [`at jsxDEV (${chunk}:1:1)`, `at Page (${chunk}:3:9)`] }])
  assert.deepEqual(out, [{ element: 'Page', createdIn: 'Page', file: 'apps/admin/src/app/page.tsx', line: 21, column: 5 }])
})

test('resolver chặn SSRF: origin trang không phải loopback, frame/map khác origin không được tải', async () => {
  const d = devServer()
  const r = createSourceMapResolver({ fetchImpl: d.fetchImpl })
  await assert.rejects(() => r.resolve('http://169.254.169.254', viteStack), /loopback/)
  d.add(VITE + '/src/a.js', '//# sourceMappingURL=http://localhost:9999/a.js.map')
  const out = await r.resolve(VITE, [{ comp: 'A', lines: ['at A (http://localhost:6000/src/a.js:1:1)', 'at B (http://localhost:5173/src/a.js:1:1)'] }])
  assert.deepEqual(d.calls, [VITE + '/src/a.js'])
  assert.match(out[0].error, /not on page origin/)
})

test('resolver: bỏ map quá lớn, giới hạn tổng cache (bỏ map cũ nhất), gộp các lần tải trùng', async () => {
  const d = devServer()
  const big = mapOf(['Big.tsx'], [[[0, 0, 0, 0]]], { pad: 'x'.repeat(5000) })
  const small = (n) => mapOf([`S${n}.tsx`], [[[0, 0, 0, 0]]], { pad: 'y'.repeat(1500) })
  d.add(VITE + '/big.js', inline(big))
  for (let i = 0; i < 4; i++) d.add(VITE + `/s${i}.js`, inline(small(i)))
  const r = createSourceMapResolver({ fetchImpl: d.fetchImpl, maxFileBytes: 4000, maxBytes: 4000 })
  const tooBig = await r.resolve(VITE, [{ comp: 'Big', lines: ['at Big (http://localhost:5173/big.js:1:1)'] }])
  assert.match(tooBig[0].error, /too large/)
  for (let i = 0; i < 4; i++) await r.resolve(VITE, [{ comp: 'S', lines: [`at S (http://localhost:5173/s${i}.js:1:1)`] }])
  assert.ok(r.cacheBytes() <= 4000, 'tổng cache trong giới hạn: ' + r.cacheBytes())
  assert.ok(r.stats.evictions >= 1)
  // Mười phần tử cùng một module chạy song song: chỉ tải một lần.
  const d2 = devServer()
  d2.add(VITE + '/one.js', inline(mapOf(['One.tsx'], [[[0, 0, 0, 0]]])))
  const r2 = createSourceMapResolver({ fetchImpl: d2.fetchImpl })
  const st = [{ comp: 'One', lines: ['at One (http://localhost:5173/one.js:1:1)'] }]
  await Promise.all(Array.from({ length: 10 }, () => r2.resolve(VITE, st)))
  assert.equal(d2.calls.length, 1)
})

test('resolver: mục hết hạn bị dọn khỏi cache (không giữ RAM), hỏi lại thì tải lại', async () => {
  let t = 0
  const d = devServer()
  d.add(VITE + '/a.js', inline(mapOf(['A.tsx'], [[[0, 0, 0, 0]]], { pad: 'z'.repeat(1000) })))
  d.add(VITE + '/b.js', inline(mapOf(['B.tsx'], [[[0, 0, 0, 0]]])))
  const r = createSourceMapResolver({ fetchImpl: d.fetchImpl, ttlMs: 1000, now: () => t })
  const st = (n) => [{ comp: n, lines: [`at ${n} (http://localhost:5173/${n}.js:1:1)`] }]
  await r.resolve(VITE, st('a'))
  assert.ok(r.cacheBytes() > 1000)
  t = 5000
  await r.resolve(VITE, st('b'))
  assert.equal(r.cacheSize(), 1, 'a đã hết hạn nên bị dọn')
  assert.ok(r.cacheBytes() < 1000)
  await r.resolve(VITE, st('a'))
  assert.equal(d.calls.filter((u) => u.endsWith('/a.js')).length, 2)
})

test('resolver: không quá `concurrency` lần tải cùng lúc', async () => {
  let active = 0, peak = 0
  const fetchImpl = async (u) => {
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 20))
    active--
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => inline(mapOf([String(u).split('/').pop() + '.tsx'], [[[0, 0, 0, 0]]])) }
  }
  const r = createSourceMapResolver({ fetchImpl, concurrency: 2 })
  await Promise.all(Array.from({ length: 8 }, (_, i) => r.resolve(VITE, [{ comp: 'C', lines: [`at C (http://localhost:5173/m${i}.js:1:1)`] }])))
  assert.ok(peak <= 2, 'peak ' + peak)
})

test('jsxSourcePositions: vị trí từng đối tượng __source trong code đã phục vụ', () => {
  const js = 'a\n  jsxDEV(X, {}, void 0, false, {\n    fileName: "F:/w/X.tsx",\n    lineNumber: 243,\n    columnNumber: 13\n  })\n{ lineNumber: 7, columnNumber: 2 }'
  const p = jsxSourcePositions(js)
  assert.deepEqual(p.get('243:13'), [4, 5])
  assert.deepEqual(p.get('7:2'), [7, 3])
})

test('remapDebugSources (Vite): dòng _debugSource lệch do phần đầu React Refresh được chỉnh về dòng gốc; 404 thì giữ nguyên', async () => {
  // Code đã phục vụ: dòng 3 chứa đối tượng __source của phần tử ở dòng gốc 224 (cột 13); _debugSource báo 243:13.
  const served = 'import x\nvar _s\njsxDEV(T, {}, void 0, false, { fileName: "F:/w/src/Layout.tsx", lineNumber: 243, columnNumber: 13 })\n'
  const at = served.split('\n')[2].indexOf('lineNumber') // cột 0-based của đối tượng trên dòng 3
  const map = mapOf(['Layout.tsx'], [[], [], [[0, 0, 223, 12], [at, 0, 223, 12]]])
  const d = devServer()
  d.add(VITE + '/@fs/F:/w/src/Layout.tsx', served + inline(map))
  const r = createSourceMapResolver({ fetchImpl: d.fetchImpl })
  const items = [{ element: 'T', createdIn: null, file: 'F:/w/src/Layout.tsx', line: 243, column: 13 }]
  assert.deepEqual(await r.remapDebugSources(VITE, items), [{ ...items[0], line: 224, column: 13 }])
  // Next: /@fs/ trả 404 -> giữ nguyên và không hỏi lại trong 5 phút.
  const n = devServer()
  const rn = createSourceMapResolver({ fetchImpl: n.fetchImpl })
  const it2 = [{ element: 'T', createdIn: null, file: 'F:/w/src/Page.tsx', line: 10, column: 3 }]
  assert.deepEqual(await rn.remapDebugSources('http://localhost:3000', it2), it2)
  assert.deepEqual(await rn.remapDebugSources('http://localhost:3000', it2), it2)
  assert.equal(n.calls.length, 1)
  // Trang ngoài loopback: không tải gì.
  assert.deepEqual(await rn.remapDebugSources('https://example.com', it2), it2)
  assert.equal(n.calls.length, 1)
})

test('Server Component (Next): đọc map cạnh chunk server trong .next; ngoài .next thì bỏ qua', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-rsc-'))
  try {
    const chunkDir = path.join(dir, 'app', '.next', 'dev', 'server', 'chunks', 'ssr')
    fs.mkdirSync(chunkDir, { recursive: true })
    const chunk = path.join(chunkDir, '[root-of-the-server]__abc._.js')
    fs.writeFileSync(chunk + '.map', JSON.stringify({ version: 3, sections: [
      { offset: { line: 45, column: 0 }, map: mapOf([path.join(dir, 'app', 'page.tsx').replace(/\\/g, '/')], [[[370, 0, 20, 6]]]) },
    ] }))
    const enc = encodeURIComponent(chunk)
    assert.equal(parseServerFrame(`at Page (about://React/Server/${enc}?31:46:375)`).file, path.resolve(chunk))
    assert.equal(parseServerFrame(`at X (about://React/Server/${encodeURIComponent(path.join(dir, 'secret.js'))}?1:1:1)`), null)
    for (const unc of ['\\\\evil\\share\\.next\\x.js', '//evil/share/.next/x.js', 'app/.next/x.js']) {
      assert.equal(parseServerFrame(`at X (about://React/Server/${encodeURIComponent(unc)}?1:1:1)`), null, unc)
    }
    const r = createSourceMapResolver({ fetchImpl: async () => { throw new Error('no network') } })
    const out = await r.resolve('http://localhost:3000', [{ comp: 'header', lines: [
      'at fakeJSXCallSite (http://localhost:3000/_next/static/chunks/react-server-dom.js:1:1)',
      `at Page (about://React/Server/${enc}?31:46:375)`,
    ] }])
    assert.deepEqual(out, [{ element: 'header', createdIn: 'Page', file: path.join(dir, 'app', 'page.tsx').replace(/\\/g, '/'), line: 21, column: 7 }])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('resolver: map lớn (~5 MB) tra trong thời gian ngắn', async () => {
  const lines = []
  for (let i = 0; i < 60000; i++) lines.push([[0, 0, i, 0], [30, 1, i, 4], [60, 0, i, 9], [90, 1, i, 2]])
  const m = mapOf(['A.tsx', 'B.tsx'], lines)
  assert.ok(m.mappings.length > 1_000_000)
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) lookup(m, 1 + Math.floor(Math.random() * 60000), 61)
  const ms = performance.now() - t0
  assert.ok(ms < 1000, `50 lần tra mất ${ms | 0} ms`)
})
