// Ngôn ngữ của thông báo cho NGƯỜI (CLI). Văn bản cho agent (MCP, payload, next_step) luôn tiếng Anh.
// UIFB_LANG=vi|en để ép; nếu không thì theo LC_ALL/LC_MESSAGES/LANG, rồi locale hệ thống (Intl). Đọc mỗi lần gọi để test đặt được.
export function lang() {
  const env = process.env
  const v = env.UIFB_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || ''
  return /^vi/i.test(v) ? 'vi' : 'en'
}
// L('tiếng Việt', 'English')
export const L = (vi, en) => (lang() === 'vi' ? vi : en)
