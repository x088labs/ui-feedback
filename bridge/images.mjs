// Ảnh người dùng dán/thả vào khung chat của overlay. Bridge giữ ảnh trong RAM (có trần tổng);
// MCP trả ảnh dạng khối image; CLI ghi ảnh ra thư mục tạm để agent mở bằng đường dẫn, bridge dọn khi bỏ tin.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 1536 * 1024
// Trần tổng dung lượng ảnh trong bộ nhớ bridge. Vượt thì bỏ ảnh của tin đã xong (cũ trước), rồi mới từ chối tin mới.
export const MAX_IMAGE_TOTAL = 64 * 1024 * 1024
// Body của /api/feedback: đủ cho MAX_IMAGES ảnh base64 (~4/3) cộng phần còn lại.
export const MAX_FEEDBACK_BODY = Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3) + 512 * 1024
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export const imageDir = () => process.env.UIFB_IMG_DIR || path.join(os.tmpdir(), 'tl-ui-feedback-images')

// Nhận diện định dạng theo magic bytes, không tin mime do trang khai.
export function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif'
  return null
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })
const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : null)

// Kiểm tra mảng images[] trang gửi lên. Trả [{n, mime, w, h, bytes, data}] (data: base64), ném lỗi có status khi sai.
export function parseImages(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw bad('images must be an array')
  if (list.length > MAX_IMAGES) throw bad(`at most ${MAX_IMAGES} images`)
  return list.map((x, i) => {
    const raw = typeof x?.data === 'string' ? x.data.replace(/^data:[^,]*,/, '') : ''
    if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw bad(`image ${i + 1}: invalid base64`)
    const buf = Buffer.from(raw, 'base64')
    if (buf.length > MAX_IMAGE_BYTES) throw bad(`image ${i + 1}: larger than ${MAX_IMAGE_BYTES} bytes`, 413)
    const mime = sniff(buf)
    if (!mime) throw bad(`image ${i + 1}: not a png, jpeg, webp or gif`)
    return { n: i + 1, mime, w: dim(x.w), h: dim(x.h), bytes: buf.length, data: buf.toString('base64') }
  })
}

// Phần đưa vào lịch sử/SSE: không mang dữ liệu ảnh.
export const imageMeta = (imgs) => (imgs || []).map(({ n, mime, w, h, bytes }) => ({ n, mime, w, h, bytes }))

export const imageFile = (id, img, dir = imageDir()) => path.join(dir, `${id}-${img.n}.${EXT[img.mime] || 'bin'}`)

// CLI: ghi ảnh của tin ra thư mục tạm, gắn `path` vào từng ảnh để in cho agent.
// Ghi lỗi (thư mục chỉ đọc, hết đĩa) không được làm mất phần chữ của tin đã giao: gắn `error` và đi tiếp.
// strip: bỏ base64 sau khi ghi (output `--json` gọn, agent mở file theo `path`).
export function saveImages(item, dir = imageDir(), { strip = false } = {}) {
  if (!item.images?.length) return item
  for (const img of item.images) {
    if (!img.data) continue
    try {
      fs.mkdirSync(dir, { recursive: true })
      const p = imageFile(item.id, img, dir)
      fs.writeFileSync(p, Buffer.from(img.data, 'base64'), { mode: 0o600 })
      img.path = p
      if (strip) delete img.data
    } catch (e) {
      img.error = e.code || e.message
      if (strip) delete img.data
    }
  }
  return item
}

// Bridge: xóa file tạm của một tin (khi tin rời bộ nhớ hoặc ảnh bị bỏ do vượt trần).
export function removeImages(id, dir = imageDir()) {
  let names
  try { names = fs.readdirSync(dir) } catch { return }
  for (const f of names) if (f.startsWith(id + '-')) try { fs.unlinkSync(path.join(dir, f)) } catch {}
}

// Bridge khởi động: xóa file tạm cũ hơn maxAgeMs (tin của phiên bridge trước không còn trong bộ nhớ).
export function sweepImages(maxAgeMs = 24 * 3600000, dir = imageDir()) {
  let names
  try { names = fs.readdirSync(dir) } catch { return }
  const now = Date.now()
  for (const f of names) {
    const p = path.join(dir, f)
    try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p) } catch {}
  }
}
