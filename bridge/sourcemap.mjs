// Tra file:dòng nguồn qua source map của dev server (Vite, Next/Turbopack, webpack) khi không có Metro /symbolicate.
// Node thuần, không dependency: tự giải mã VLQ. Chỉ tải từ đúng origin của trang và chỉ origin loopback (chặn SSRF).
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'

const B64 = new Int8Array(128).fill(-1)
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i })
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
// Lưu trạng thái giải mã mỗi CHECKPOINT dòng: tra một vị trí chỉ phải giải mã tối đa ngần ấy dòng thay vì cả file.
const CHECKPOINT = 128
// Nguồn không phải mã app: thư viện, runtime của bundler.
const NOT_APP = /node_modules|^\[turbopack\]|^\[next\]|webpack\/(runtime|bootstrap)|^webpack\/|\(webpack\)/
// URL chắc chắn là thư viện (Vite tiền đóng gói deps): bỏ qua, không tải.
const LIB_URL = /\/node_modules\//

export const parseFrame = (l) => {
  const m = String(l).match(/at (?:(\S+) )?\(?(https?:\/\/[^\s)]+?):(\d+):(\d+)\)?$/)
  return m ? { methodName: m[1] || '', url: m[2], line: +m[3], column: +m[4] } : null
}

// Server Component (Next App Router): React ghi frame theo file chunk server trên đĩa,
// vd "at Page (about://React/Server/F:%5C...%5C.next%5Cdev%5Cserver%5Cchunks%5Cssr%5Cx._.js?31:46:375)".
// Chỉ nhận file .js nằm trong thư mục .next (map của nó nằm cạnh: <file>.js.map).
export const parseServerFrame = (l) => {
  const m = String(l).match(/at (?:(\S+) )?\(?(?:about|rsc):\/\/React\/Server\/([^\s)]+?)(?:\?[^\s):]*)?:(\d+):(\d+)\)?$/)
  if (!m) return null
  let p
  try {
    p = decodeURIComponent(m[2])
    if (p.startsWith('file://')) p = fileURLToPath(p)
  } catch { return null }
  // Chặn đường dẫn mạng (UNC \\host\share, //host/share): đọc chúng làm Windows mở kết nối SMB ra máy khác.
  if (/^[\\/]{2}/.test(p) || !path.isAbsolute(p)) return null
  p = path.resolve(p)
  if (!path.isAbsolute(p) || !/\.js$/.test(p) || !p.split(/[\\/]/).includes('.next')) return null
  return { methodName: m[1] || '', file: p, line: +m[3], column: +m[4] }
}

// Giải mã các đoạn của một dòng [pos, stop); st = [src, srcLine, srcCol] được cập nhật tại chỗ.
// onSeg(genCol, src, srcLine, srcCol) gọi cho mỗi đoạn có nguồn; trả true để dừng sớm.
function decodeLine(s, pos, stop, st, onSeg) {
  let gc = 0
  while (pos < stop) {
    let n = 0
    let f0 = 0, f1 = 0, f2 = 0, f3 = 0
    while (pos < stop) {
      const ch = s.charCodeAt(pos)
      if (ch === 44) { pos++; break } // ','
      let v = 0, sh = 0, d
      do {
        d = B64[s.charCodeAt(pos++)]
        if (d < 0 || d === undefined) throw new Error('bad mappings')
        v += (d & 31) * 2 ** sh
        sh += 5
      } while (d & 32)
      v = v % 2 === 1 ? -(v - 1) / 2 : v / 2
      if (n === 0) f0 = v; else if (n === 1) f1 = v; else if (n === 2) f2 = v; else if (n === 3) f3 = v
      n++
    }
    gc += f0
    if (n >= 4) {
      st[0] += f1; st[1] += f2; st[2] += f3
      if (onSeg && onSeg(gc, st[0], st[1], st[2])) return
    }
  }
}

function prepare(map) {
  if (map._cps) return map
  const s = map.mappings
  const cps = []
  const st = [0, 0, 0]
  let pos = 0
  for (let line = 0; ; line++) {
    if (line % CHECKPOINT === 0) cps.push([pos, st[0], st[1], st[2]])
    const end = s.indexOf(';', pos)
    const stop = end === -1 ? s.length : end
    decodeLine(s, pos, stop, st, null)
    if (end === -1) break
    pos = end + 1
  }
  map._cps = cps
  return map
}

// line, column: 1-based như trong stack trace của V8. Trả { source, line, column } (1-based) hoặc null.
export function lookup(map, line, column) {
  if (!map) return null
  if (Array.isArray(map.sections)) {
    let sec = null
    for (const x of map.sections) {
      const o = x.offset || {}
      if (o.line < line - 1 || (o.line === line - 1 && o.column <= column - 1)) sec = x
      else break
    }
    if (!sec || !sec.map) return null
    const o = sec.offset
    return lookup(sec.map, line - o.line, o.line === line - 1 ? column - o.column : column)
  }
  if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null
  prepare(map)
  const l0 = line - 1
  const c0 = column - 1
  const cp = map._cps[Math.floor(l0 / CHECKPOINT)]
  if (!cp) return null
  const s = map.mappings
  const st = [cp[1], cp[2], cp[3]]
  let pos = cp[0]
  for (let l = Math.floor(l0 / CHECKPOINT) * CHECKPOINT; l < l0; l++) {
    const end = s.indexOf(';', pos)
    if (end === -1) return null
    decodeLine(s, pos, end, st, null)
    pos = end + 1
  }
  const end = s.indexOf(';', pos)
  let best = null
  let first = null
  decodeLine(s, pos, end === -1 ? s.length : end, st, (gc, src, sl, sc) => {
    const hit = { src, sl, sc }
    if (!first) first = hit
    if (gc > c0) return true
    best = hit
  })
  const h = best || first
  if (!h || map.sources[h.src] == null) return null
  const root = map.sourceRoot ? String(map.sourceRoot).replace(/\/?$/, '/') : ''
  return { source: root + map.sources[h.src], line: h.sl + 1, column: h.sc + 1 }
}

// Đổi tên nguồn trong map thành đường dẫn agent mở được.
export function normalizeSource(source, mapUrl) {
  let s = String(source)
  try {
    if (s.startsWith('file://')) return fileURLToPath(s).replace(/\\/g, '/')
  } catch {}
  // Turbopack/webpack ghi đường dẫn tính từ gốc dự án: giữ nguyên dạng tương đối đó.
  const projectRel = /^(turbopack:\/\/\/\[project\]\/|webpack:\/\/[^/]*\/)/.test(s)
  s = s.replace(/^turbopack:\/\/\/\[project\]\//, '')
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^\.\//, '')
    .replace(/[?#].*$/, '')
  if (projectRel || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || /^[a-z]+:/i.test(s)) return s.replace(/\\/g, '/')
  // Tương đối (Vite): tính theo vị trí file map trên dev server, ra đường dẫn kiểu /src/App.tsx.
  try { return decodeURIComponent(new URL(s, mapUrl).pathname) } catch { return s }
}

const sameLoopbackOrigin = (u, origin) => {
  try {
    const x = new URL(u)
    return x.origin === origin && LOOPBACK.has(x.hostname)
  } catch { return false }
}

// Vị trí (dòng, cột 1-based) của mỗi đối tượng __source { lineNumber: N, columnNumber: C } trong code JSX dev, khóa "N:C".
export function jsxSourcePositions(js) {
  const out = new Map()
  const re = /lineNumber:\s*(\d+),\s*columnNumber:\s*(\d+)/g
  let m
  let line = 1
  let lineStart = 0
  while ((m = re.exec(js))) {
    // Đếm số dòng từ lần khớp trước tới lần khớp này (chỉ quét một lượt qua cả file).
    for (let i = js.indexOf('\n', lineStart); i !== -1 && i < m.index; i = js.indexOf('\n', i + 1)) { line++; lineStart = i + 1 }
    const k = m[1] + ':' + m[2]
    if (!out.has(k)) out.set(k, [line, m.index - lineStart + 1])
    if (out.size > 20000) break
  }
  return out
}

export function createSourceMapResolver({
  fetchImpl = fetch,
  maxBytes = 32 * 1024 * 1024, // tổng cache (tính theo độ dài văn bản map; object đã parse chiếm RAM nhiều hơn)
  maxFileBytes = 20 * 1024 * 1024, // một file JS hoặc map
  ttlMs = 30000, // map sau HMR đổi nội dung mà URL có thể giữ nguyên (Next): không giữ lâu
  concurrency = 4,
  timeoutMs = 5000,
  now = () => Date.now(),
} = {}) {
  const cache = new Map() // scriptUrl -> { at, size, map|null, error? }
  const inflight = new Map()
  let total = 0
  let active = 0
  const waiting = []
  const stats = { fetches: 0, hits: 0, evictions: 0 }

  const acquire = () => new Promise((r) => { if (active < concurrency) { active++; r() } else waiting.push(r) })
  const release = () => { const n = waiting.shift(); if (n) n(); else active-- }

  async function fetchText(u) {
    await acquire()
    try {
      stats.fetches++
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) })
      if (r.ok === false) throw new Error('HTTP ' + r.status)
      const len = +(r.headers?.get?.('content-length') || 0)
      if (len > maxFileBytes) throw new Error('too large')
      if (r.body?.getReader) {
        const rd = r.body.getReader()
        const chunks = []
        let n = 0
        for (;;) {
          const { done, value } = await rd.read()
          if (done) break
          n += value.byteLength
          if (n > maxFileBytes) { rd.cancel().catch(() => {}); throw new Error('too large') }
          chunks.push(value)
        }
        return Buffer.concat(chunks).toString('utf8')
      }
      const t = await r.text()
      if (t.length > maxFileBytes) throw new Error('too large')
      return t
    } finally { release() }
  }

  async function load(scriptUrl, origin) {
    const js = await fetchText(scriptUrl)
    const i = js.lastIndexOf('sourceMappingURL=')
    if (i === -1) return { map: null, size: 0 }
    const ref = js.slice(i + 17).match(/^[^\s'"*]+/)?.[0]
    if (!ref) return { map: null, size: 0 }
    let text
    let mapUrl = scriptUrl
    if (ref.startsWith('data:')) {
      const comma = ref.indexOf(',')
      const meta = ref.slice(5, comma)
      const data = ref.slice(comma + 1)
      text = /;base64$/.test(meta) ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data)
    } else {
      mapUrl = new URL(ref, scriptUrl).href
      if (!sameLoopbackOrigin(mapUrl, origin)) throw new Error('map url not on page origin')
      text = await fetchText(mapUrl)
    }
    const map = JSON.parse(text)
    map._url = mapUrl
    if (Array.isArray(map.sections)) for (const x of map.sections) if (x.map) x.map._url = mapUrl
    return { map, size: text.length, jsxPos: jsxSourcePositions(js) }
  }

  // Map của chunk Server Component nằm cạnh file trên đĩa (đã kiểm ở parseServerFrame: file .js trong thư mục .next).
  async function loadFile(file) {
    const mapFile = file + '.map'
    const st = await fs.stat(mapFile)
    if (st.size > maxFileBytes) throw new Error('too large')
    const text = await fs.readFile(mapFile, 'utf8')
    const map = JSON.parse(text)
    map._url = 'file:///x' // nguồn của Turbopack là đường dẫn tuyệt đối/tính từ dự án, không cần URL gốc
    return { map, size: text.length, jsxPos: null }
  }

  // Trả { map, jsxPos } của một file JS trên dev server hoặc (key "file:") trên đĩa; cache, gộp lần tải trùng.
  function getEntry(scriptUrl, origin) {
    const c = cache.get(scriptUrl)
    if (c && now() - c.at < ttlMs) {
      stats.hits++
      cache.delete(scriptUrl); cache.set(scriptUrl, c) // LRU: đưa lên cuối
      if (c.error) throw new Error(c.error)
      return c
    }
    if (c) { cache.delete(scriptUrl); total -= c.size }
    if (inflight.has(scriptUrl)) return inflight.get(scriptUrl)
    const p = (scriptUrl.startsWith('file:') ? loadFile(scriptUrl.slice(5)) : load(scriptUrl, origin)).then(({ map, size, jsxPos }) => {
      const e = { at: now(), size, map, jsxPos }
      put(scriptUrl, e)
      return e
    }, (e) => {
      put(scriptUrl, { at: now(), size: 0, map: null, error: e.message })
      throw e
    }).finally(() => inflight.delete(scriptUrl))
    inflight.set(scriptUrl, p)
    return p
  }

  function put(k, v) {
    // Dọn mục hết hạn trước: không giữ map cũ trong RAM chỉ vì chưa ai hỏi lại URL đó.
    for (const [key, e] of cache) if (now() - e.at >= ttlMs) { cache.delete(key); total -= e.size }
    cache.set(k, v)
    total += v.size
    for (const [key, e] of cache) {
      if (total <= maxBytes || key === k) break
      cache.delete(key); total -= e.size; stats.evictions++
    }
  }

  // stacks: [{ comp, lines }] như symbolicate(). Trả cùng dạng: [{ element, createdIn, file, line, column }].
  async function resolve(origin, stacks) {
    let o
    try { o = new URL(origin) } catch { throw Object.assign(new Error('page origin invalid'), { status: 400 }) }
    if (!LOOPBACK.has(o.hostname)) throw Object.assign(new Error('page origin not loopback'), { status: 400 })
    origin = o.origin
    const out = []
    const seen = new Set()
    let lastErr = null
    for (const st of (stacks || []).slice(0, 12)) {
      const frames = (st.lines || []).slice(0, 30).map((l) => parseFrame(l) || parseServerFrame(l)).filter(Boolean)
      let hit = null
      for (const f of frames) {
        if (f.url && (LIB_URL.test(f.url) || !sameLoopbackOrigin(f.url, origin))) continue
        let map
        try { map = (await getEntry(f.url || 'file:' + f.file, origin)).map } catch (e) { lastErr = e; continue }
        let pos
        try { pos = lookup(map, f.line, f.column) } catch (e) { lastErr = e; continue }
        if (!pos) continue
        const file = normalizeSource(pos.source, map._url || f.url)
        if (NOT_APP.test(pos.source) || NOT_APP.test(file)) continue
        hit = { element: String(st.comp), createdIn: f.methodName || null, file, line: pos.line, column: pos.column }
        break
      }
      if (!hit) continue
      const key = `${hit.file}:${hit.line}:${hit.column}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(hit)
      if (out.length >= 8) break
    }
    if (!out.length && lastErr) out.push({ error: 'source map lookup failed: ' + lastErr.message })
    return out
  }

  // React 18 + Vite: _debugSource ghi dòng của code trung gian (đã chèn phần đầu React Refresh), lệch so với file gốc.
  // Tải module qua /@fs/<đường dẫn tuyệt đối> của Vite, tìm đúng đối tượng { lineNumber, columnNumber } đó trong code
  // đã phục vụ rồi tra vị trí của nó qua source map của module. Không phải Vite (404) thì giữ nguyên (Babel/SWC của
  // Next/webpack ghi đúng dòng gốc) và nhớ origin đó 5 phút để khỏi hỏi lại.
  const noViteFs = new Map()
  async function remapDebugSources(origin, items) {
    let o
    try { o = new URL(origin) } catch { return items }
    if (!LOOPBACK.has(o.hostname)) return items
    origin = o.origin
    return Promise.all(items.map(async (it) => {
      if (!(noViteFs.get(origin) > now()) && /^([A-Za-z]:\/|\/)/.test(it.file) && it.column != null) {
        const u = origin + '/@fs/' + encodeURI(it.file.replace(/^\/+/, ''))
        try {
          const e = await getEntry(u, origin)
          const pos = e.jsxPos && e.jsxPos.get(it.line + ':' + it.column)
          const m = pos && lookup(e.map, pos[0], pos[1])
          if (m) return { ...it, line: m.line, column: m.column }
        } catch (err) {
          if (/HTTP 404/.test(err.message)) noViteFs.set(origin, now() + 5 * 60000)
        }
      }
      return it
    }))
  }

  return { resolve, remapDebugSources, stats, cacheBytes: () => total, cacheSize: () => cache.size }
}
