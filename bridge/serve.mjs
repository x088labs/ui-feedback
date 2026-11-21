// `tl-ui-feedback serve`: phục vụ site (thư mục hoặc file HTML) trên 127.0.0.1 và chèn overlay.
// Node thuần, không dependency. Hai chế độ: static (thư mục/file) và proxy (URL dev server).
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { injectOverlay, OVERLAY_PATH } from './inject.mjs'
import { stateDir, isLoopbackOrigin, isLoopbackHost, OVERLAY_FILE } from './server.mjs'
import { L } from './i18n.mjs'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
}
const typeOf = (f) => TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream'

// Đổi đường dẫn URL thành file nằm trong root; null nếu thoát ra ngoài, có file ẩn hoặc không tồn tại.
// root phải là đường dẫn thật (realpath). Chặn ".." cả khi mã hóa, symlink trỏ ra ngoài và dotfile.
export function resolveStatic(root, urlPath) {
  let rel
  try { rel = decodeURIComponent(urlPath) } catch { return null }
  if (rel.includes('\0')) return null
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return null
  let file = path.join(root, ...parts)
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    file = fs.realpathSync(file)
  } catch { return null }
  const inside = file === root || file.startsWith(root + path.sep)
  return inside && fs.statSync(file).isFile() ? file : null
}

// Dấu vân tay thay đổi của site tĩnh (mtime+size mọi file không ẩn): overlay hỏi định kỳ để tự tải lại trang sau khi sửa file.
export const VERSION_PATH = '/__uifb/version'
// serve trả PID của chính nó: `serve --stop` chỉ kill khi PID trong file trạng thái đúng là tiến trình đang giữ cổng.
export const PING_PATH = '/__uifb/ping'
const pingBody = () => JSON.stringify({ name: 'ui-feedback-serve', pid: process.pid })
export function siteVersion(root) {
  let n = 0, sum = 0, max = 0
  const walk = (dir, depth) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (n > 20000) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (depth < 8) walk(p, depth + 1) }
      else if (e.isFile()) { try { const t = fs.statSync(p); n++; sum += t.size; max = Math.max(max, t.mtimeMs) } catch {} }
    }
  }
  walk(root, 0)
  return n + ':' + sum + ':' + Math.round(max)
}

export function createStaticSite({ site, bridgeUrl, spa = false }) {
  const abs = path.resolve(site)
  const st = fs.statSync(abs) // ném lỗi nếu không tồn tại
  const root = fs.realpathSync(st.isDirectory() ? abs : path.dirname(abs))
  const entry = st.isFile() ? fs.realpathSync(abs) : null // file đơn: phục vụ ở "/"
  let ver = null

  return http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (!isLoopbackHost(req)) return send(403, 'bad host')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed')
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname

    if (urlPath === OVERLAY_PATH) return send(200, fs.readFileSync(OVERLAY_FILE), 'text/javascript; charset=utf-8')

    if (urlPath === PING_PATH) return send(200, pingBody(), 'application/json; charset=utf-8')
    if (urlPath === VERSION_PATH) {
      // Mỗi tab bật "Tự tải lại" hỏi mỗi giây: dùng lại kết quả trong 500 ms thay vì duyệt cả cây thư mục mỗi lần.
      if (!ver || Date.now() - ver.at > 500) ver = { at: Date.now(), v: siteVersion(root) }
      return send(200, JSON.stringify({ v: ver.v }), 'application/json; charset=utf-8')
    }

    let file = entry && (urlPath === '/' || urlPath === '/index.html') ? entry : resolveStatic(root, urlPath)
    if (!file && spa && !path.extname(urlPath)) file = entry || resolveStatic(root, '/')
    if (!file) return send(404, 'not found')
    const type = typeOf(file)
    if (type.startsWith('text/html')) return send(200, injectOverlay(fs.readFileSync(file, 'utf8'), bridgeUrl), type)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
  })
}


// ---------- Chế độ proxy: đặt phía trước một dev server, chèn overlay vào HTML ----------
export function createProxySite({ upstream, bridgeUrl, allowRemote = false }) {
  const up = new URL(upstream)
  if (up.protocol !== 'http:' && up.protocol !== 'https:') throw new Error(L('upstream phải là http hoặc https', 'upstream must be http or https'))
  if (!allowRemote && !isLoopbackOrigin(up.origin)) {
    throw new Error(L(`upstream ${up.origin} không phải loopback; thêm --allow-remote-upstream nếu bạn chắc chắn`, `upstream ${up.origin} is not loopback; add --allow-remote-upstream if you are sure`))
  }
  const secure = up.protocol === 'https:'
  const lib = secure ? https : http
  const upOrigin = up.origin
  const upHost = up.hostname.replace(/^\[|\]$/g, '')
  const upPort = +up.port || (secure ? 443 : 80)
  // Origin (nếu có) phải chính là origin của proxy; nếu không, site lạ sẽ "mượn" Origin của upstream sau khi bị viết lại.
  const originOk = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`

  const server = http.createServer((req, res) => {
    const fail = (code, msg) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html><meta charset="utf-8"><title>${code}</title><body style="font:14px system-ui;padding:24px"><h3>${code}</h3><p>${msg}</p>`)
    }
    if (!isLoopbackHost(req)) return fail(403, 'bad host')
    if (!originOk(req)) return fail(403, 'bad origin')
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname
    if (urlPath === OVERLAY_PATH || urlPath === PING_PATH) {
      res.writeHead(200, { 'content-type': urlPath === PING_PATH ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(urlPath === PING_PATH ? pingBody() : fs.readFileSync(OVERLAY_FILE))
    }
    const proxyOrigin = `http://${req.headers.host}`
    const headers = { ...req.headers, host: up.host, 'accept-encoding': 'identity' }
    if (headers.origin) headers.origin = upOrigin
    if (headers.referer) headers.referer = headers.referer.split(proxyOrigin).join(upOrigin)
    const preq = lib.request({ host: upHost, port: upPort, path: req.url, method: req.method, headers }, (pres) => {
      // Upstream ngắt giữa chừng (dev server khởi động lại): không có listener thì sự kiện 'error' làm sập cả serve.
      pres.on('error', () => res.destroy())
      const h = { ...pres.headers }
      if (typeof h.location === 'string' && h.location.startsWith(upOrigin)) h.location = proxyOrigin + h.location.slice(upOrigin.length)
      const code = pres.statusCode
      const canInject = req.method !== 'HEAD' && code !== 204 && code !== 304 && /text\/html/i.test(h['content-type'] || '') &&
        (!h['content-encoding'] || h['content-encoding'] === 'identity')
      if (!canInject) {
        res.writeHead(code, pres.statusMessage, h)
        return pres.pipe(res)
      }
      const chunks = []
      pres.on('data', (c) => chunks.push(c))
      pres.on('end', () => {
        const body = Buffer.from(injectOverlay(Buffer.concat(chunks).toString('utf8'), bridgeUrl), 'utf8')
        delete h['transfer-encoding']
        h['content-length'] = String(body.length)
        res.writeHead(code, pres.statusMessage, h)
        res.end(body)
      })
    })
    preq.on('error', (e) => fail(502, L(`Không kết nối được ${upOrigin} (${e.code || e.message}). Dev server đã chạy chưa? Tải lại trang sau khi chạy.`, `Cannot reach ${upOrigin} (${e.code || e.message}). Is the dev server running? Reload the page once it is.`)))
    res.on('close', () => { if (!res.writableEnded) preq.destroy() })
    req.on('error', () => preq.destroy())
    req.pipe(preq)
  })

  // WebSocket (HMR của Metro/Vite): chuyển nguyên byte hai chiều sau khi viết lại Host và Origin.
  server.tunnels = new Set() // socket WebSocket đã nâng cấp: closeAllConnections() của Node không đóng chúng
  server.on('upgrade', (req, socket, head) => {
    if (!isLoopbackHost(req) || !originOk(req)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    const s = secure ? tls.connect({ host: upHost, port: upPort, servername: upHost }) : net.connect(upPort, upHost)
    s.once(secure ? 'secureConnect' : 'connect', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        const l = k.toLowerCase()
        const v = l === 'host' ? up.host : l === 'origin' ? upOrigin : req.rawHeaders[i + 1]
        raw += `${k}: ${v}\r\n`
      }
      s.write(raw + '\r\n')
      if (head && head.length) s.write(head)
      s.pipe(socket)
      socket.pipe(s)
    })
    server.tunnels.add(socket).add(s)
    const kill = () => { s.destroy(); socket.destroy(); server.tunnels.delete(socket); server.tunnels.delete(s) }
    s.on('error', kill); socket.on('error', kill); s.on('close', kill); socket.on('close', kill)
  })
  return server
}


// ---------- --cmd: chạy dev server rồi chờ nó sẵn sàng ----------
// Dừng cả cây tiến trình (shell + dev server + con của nó). Windows dùng taskkill, nơi khác dùng nhóm tiến trình.
export function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else {
      try { process.kill(-pid, 'SIGTERM') } catch { process.kill(pid, 'SIGTERM') }
    }
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// true nếu upstream trả lời bất kỳ status nào cho GET /.
export function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const lib = /^https:/i.test(url) ? https : http
    const req = lib.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

export async function runDevCommand({ command, cwd = process.cwd(), upstream, timeoutMs = 60000, log = (l) => process.stderr.write(l) }) {
  if (await probe(upstream)) throw new Error(L(`đã có server trả lời ở ${upstream}; bỏ --cmd hoặc dừng server đó trước`, `a server already answers at ${upstream}; drop --cmd or stop that server first`))
  const child = spawn(command, { shell: true, cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', log)
  child.stderr.on('data', log)
  let exited = null
  child.on('exit', (code, sig) => { exited = { code, sig } })
  const stop = () => killTree(child.pid)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (exited) {
      stop()
      throw new Error(L(`lệnh dừng sớm (mã ${exited.code ?? exited.sig}) trước khi ${upstream} trả lời`, `the command exited early (code ${exited.code ?? exited.sig}) before ${upstream} answered`))
    }
    if (await probe(upstream)) return { pid: child.pid, stop, child }
    await sleep(250)
  }
  stop()
  throw new Error(L(`đã chờ ${Math.round(timeoutMs / 1000)} giây mà ${upstream} chưa trả lời; đã dừng lệnh`, `waited ${Math.round(timeoutMs / 1000)}s and ${upstream} did not answer; stopped the command`))
}

// ---------- Trạng thái các lần serve đang chạy ----------
const stateFile = (port, dir = stateDir()) => path.join(dir, `serve-${port}.json`)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

export function listServes(dir = stateDir()) {
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => /^serve-\d+\.json$/.test(n)) } catch { return [] }
  const out = []
  for (const n of names) {
    const f = path.join(dir, n)
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (alive(s.pid)) out.push(s)
      else fs.rmSync(f, { force: true }) // dọn trạng thái của tiến trình đã chết
    } catch { fs.rmSync(f, { force: true }) }
  }
  return out.sort((a, b) => a.port - b.port)
}

// PID của tiến trình serve đang giữ cổng (hỏi PING_PATH); 0 nếu không trả lời.
export function servePid(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: +port, path: PING_PATH, timeout: timeoutMs }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j.name === 'ui-feedback-serve' ? +j.pid || 0 : 0) } catch { resolve(0) } })
    })
    req.on('error', () => resolve(0))
    req.on('timeout', () => { req.destroy(); resolve(null) }) // null: có thứ giữ cổng nhưng không trả lời kịp (khác "không có serve")
  })
}

// Chỉ kill khi serve ở cổng đó trả lời đúng PID ghi trong file trạng thái (PID có thể đã bị tiến trình khác dùng lại).
export async function stopServe(port, dir = stateDir()) {
  const s = listServes(dir).find((x) => x.port === +port)
  if (!s) return false
  const pid = await servePid(port)
  // Chỉ bị timeout: serve có thể đang bận. Giữ file trạng thái, nếu không --list/--stop sẽ mất dấu một serve còn sống.
  if (pid === null) throw new Error(L(`serve ở cổng ${port} không trả lời; thử lại sau`, `serve on port ${port} did not answer; try again later`))
  if (pid !== s.pid) {
    fs.rmSync(stateFile(port, dir), { force: true }) // trạng thái cũ: không kill gì cả
    return false
  }
  killTree(s.childPid) // dev server do --cmd chạy: dừng trước, kẻo mồ côi khi serve bị kill cứng (Windows)
  try { process.kill(s.pid) } catch {}
  fs.rmSync(stateFile(port, dir), { force: true })
  return true
}

// Mở server, ghi trạng thái. Trả { port, close }. Cổng bận thì ném lỗi rõ ràng.
export async function startServe({ port, site, bridgeUrl, spa = false, allowRemote = false, childPid = null, dir = stateDir() }) {
  const isUrl = /^https?:\/\//i.test(site)
  const server = isUrl ? createProxySite({ upstream: site, bridgeUrl, allowRemote }) : createStaticSite({ site, bridgeUrl, spa })
  const actual = await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(L(`cổng ${port} đang bị chiếm`, `port ${port} is in use`)) : e))
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(stateFile(actual, dir), JSON.stringify({ port: actual, pid: process.pid, site: isUrl ? site : path.resolve(site), mode: isUrl ? 'proxy' : 'static', childPid }))
  return {
    port: actual,
    close: () => new Promise((resolve) => {
      fs.rmSync(stateFile(actual, dir), { force: true })
      server.closeAllConnections?.()
      for (const t of server.tunnels || []) t.destroy()
      server.close(() => resolve())
    }),
  }
}
