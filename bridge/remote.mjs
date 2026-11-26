// Origin ngoài localhost (site đã deploy, vd https://qa.example.com) được phép dùng overlay qua bookmarklet.
// Danh sách nằm ở <stateDir>/origins.json, do `tl-ui-feedback allow` ghi; bridge đọc lại khi file đổi, không cần khởi động lại.
// Trang của origin đó nhận token RIÊNG (chỉ gửi feedback và đọc luồng của chính nó), không bao giờ nhận token chính,
// và chỉ nhận token khi handshake kèm khóa ghép cặp nằm trong bookmarklet: trước khi người dùng bấm bookmarklet, script
// trên site không tự kết nối được. Sau khi bấm, khóa nằm ở window.__UIFB__ tới khi overlay.js nạp xong và xóa nó, nên
// script đang chạy trên trang lúc đó có thể đọc được (đánh đổi đã ghi ở README). Khóa gắn với nonce của lần `allow`:
// `allow --remove` rồi `allow` lại (hoặc allow lại sau khi hết hạn) đổi nonce, mọi bookmarklet và token cũ hết hiệu lực.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { L } from './i18n.mjs'

const FILE = 'origins.json'
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/

// Chuẩn hóa và kiểm tra origin cho allow: chỉ https, không phải loopback (loopback vốn đã được phép).
export function normRemoteOrigin(s) {
  let u
  try { u = new URL(String(s || '')) } catch { throw new Error(L('origin không hợp lệ: ', 'invalid origin: ') + s) }
  if (u.protocol !== 'https:') throw new Error(L('chỉ cho phép được origin https: ', 'only https origins can be allowed: ') + s)
  if (LOOPBACK.test(u.hostname)) throw new Error(L('localhost luôn được phép, không cần allow: ', 'localhost is always allowed: ') + s)
  return u.origin
}

const file = (dir) => path.join(dir, FILE)
function readRaw(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(file(dir), 'utf8'))
    return Array.isArray(j) ? j.filter((x) => x && typeof x.origin === 'string') : []
  } catch { return [] }
}
const live = (x, now = Date.now()) => !x.until || Date.parse(x.until) > now

export function listAllowed(dir) { return readRaw(dir).filter((x) => live(x)) }

// hours = 0: không hết hạn. Allow lại khi site còn hạn chỉ gia hạn (giữ nonce, bookmarklet cũ vẫn dùng được);
// site đã gỡ hoặc hết hạn thì nhận nonce mới.
export function allowOrigin(dir, origin, hours = 24) {
  const o = normRemoteOrigin(origin)
  const raw = readRaw(dir)
  const prev = raw.find((x) => x.origin === o && live(x))
  const entry = {
    origin: o, addedAt: new Date().toISOString(), until: hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null,
    nonce: (prev && typeof prev.nonce === 'string' && prev.nonce) || crypto.randomBytes(16).toString('hex'),
  }
  const list = raw.filter((x) => x.origin !== o && live(x))
  list.push(entry)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file(dir), JSON.stringify(list, null, 2), { mode: 0o600 })
  return entry
}

export function removeOrigin(dir, origin) {
  let o
  try { o = new URL(String(origin)).origin } catch { return false }
  const list = readRaw(dir)
  const rest = list.filter((x) => x.origin !== o)
  if (rest.length === list.length) return false
  fs.writeFileSync(file(dir), JSON.stringify(rest, null, 2), { mode: 0o600 })
  return true
}

// Bridge hỏi mỗi request: chỉ đọc lại file khi mtime đổi.
export function createAllowList(dir) {
  let mtime = -1
  let list = []
  // Entry còn hạn của origin, hoặc null.
  const get = (origin) => {
    if (!origin) return null
    let m = 0
    try { m = fs.statSync(file(dir)).mtimeMs } catch { m = 0 }
    if (m !== mtime) { mtime = m; list = m ? readRaw(dir) : [] }
    return list.find((x) => x.origin === origin && live(x)) || null
  }
  return { get, has: (origin) => !!get(origin) }
}

const mac = (token, label) => crypto.createHmac('sha256', token).update(label).digest('hex')
// Khóa ghép cặp (trong bookmarklet), token và khóa SSE của riêng một origin: suy ra từ token chính + nonce của lần allow
// nên không cần lưu; đổi token (xóa file token) hoặc đổi nonce là mọi bookmarklet cũ hết hiệu lực.
const label = (kind, origin, nonce) => `ui-feedback-${kind}:${origin}` + (nonce ? '#' + nonce : '')
export const pairKey = (token, origin, nonce = '') => mac(token, label('pair', origin, nonce)).slice(0, 32)
export const originToken = (token, origin, nonce = '') => 'o_' + mac(token, label('origin', origin, nonce)).slice(0, 48)
export const originSseKey = (token, origin, nonce = '') => mac(token, label('origin-sse', origin, nonce)).slice(0, 48)

// Overlay đã nạp thì bookmarklet không ghi khóa lên trang nữa (overlay chỉ xóa khóa ở lần nạp đầu của nó).
export function bookmarklet(bridge, key) {
  const b = JSON.stringify(String(bridge).replace(/\/+$/, ''))
  return `javascript:(function(){if(window.__UIFB_LOADED__)return;var b=${b};window.__UIFB__=Object.assign(window.__UIFB__||{},{bridge:b,key:${JSON.stringify(key)}});` +
    `var s=document.createElement('script');s.src=b+'/overlay.js';document.documentElement.appendChild(s)})()`
}
