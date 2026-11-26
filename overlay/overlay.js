/* UI Feedback Bridge — overlay chạy trong trang (MAIN world).
 * Do `tl-ui-feedback serve` chèn vào trang, hoặc dòng dev-only (<script src=".../overlay.js">); bridge phục vụ file này ở /overlay.js.
 * Nút nổi "Feedback" mở khung chat: lịch sử yêu cầu của bạn + phản hồi của agent + trạng thái.
 * Chọn phần tử: nút "Chọn phần tử" hoặc Alt+Shift+K → rê (khung xanh) → click (click tiếp thì thay phần tử). Ctrl+click (Cmd+click) THÊM phần tử
 * (nhãn A, B, C…, tối đa 10, có huy hiệu trên trang), mỗi phần tử có ghi chú riêng; tin nhắn chung có thể nhắc phần tử bằng [A], [B] (bấm nhãn để chèn). Gửi một lần = một tin cho agent.
 * Esc, nút hoặc Alt+Shift+K để tắt chế độ chọn. Cũng có thể gửi tin nhắn tự do không kèm phần tử.
 */
;(function () {
  'use strict'
  // Khóa ghép cặp (bookmarklet của `tl-ui-feedback allow`, cho site ngoài localhost): giữ trong closure, xóa khỏi window
  // TRƯỚC mọi lần thoát sớm, để bấm bookmarklet lần nữa (overlay đã nạp) không để khóa nằm lại trên trang.
  var PAIR = (window.__UIFB__ && window.__UIFB__.key) || ''
  if (window.__UIFB__ && 'key' in window.__UIFB__) try { delete window.__UIFB__.key } catch (_) {}
  if (window.__UIFB_LOADED__) return
  window.__UIFB_LOADED__ = true
  if (window.top !== window) return // chỉ khung chính

  var BRIDGE = (window.__UIFB__ && window.__UIFB__.bridge) || 'http://127.0.0.1:47831'
  var token = null
  var es = null
  var listening = false
  var picking = false
  var multiOn = false // nút "+": mỗi lần chạm/click là thêm phần tử (thiết bị cảm ứng không có Ctrl)
  var current = null // phần tử đang rê
  var picks = [] // phần tử đã chọn, chờ gửi: [{ ref: 'A', el, data: extract(el), note, mk: { o, b } }]
  var REFS = 'ABCDEFGHIJ' // nhãn theo thứ tự chọn; xoá một phần tử thì nhãn khác giữ nguyên để [B] trong câu không trỏ sai
  var nextRef = 0
  var warnedNote = null // tin nhắn đã được cảnh báo token [X] lạ: bấm Gửi lần nữa thì vẫn gửi
  // Ảnh dán/thả/chọn file, chờ gửi: [{ data(base64), mime, w, h, url(objectURL xem trước) }]. Giới hạn khớp bridge/images.mjs.
  var atts = []
  var MAX_ATT = 4, MAX_ATT_BYTES = 1536 * 1024, MAX_ATT_SIDE = 1600
  var thumbs = {} // 'itemId:n' -> objectURL | null (đang tải) | 'gone': thumbnail của tin đã gửi, lấy từ /api/image
  var thumbTries = {} // 'itemId:n' -> số lần tải lỗi tạm thời (mạng, bridge khởi động lại): thử lại tối đa 3 lần
  var attPending = 0 // ảnh đang thu nhỏ/đọc base64: chưa vào atts, Gửi phải đợi
  var bridgeImages = false // bridge báo hỗ trợ ảnh trong handshake (bridge cũ còn chạy nền thì không)
  var open = false
  var pinned = false // ghim: khung dính mép phải trang, trang co lại nhường chỗ
  var pinW = 380 // chiều rộng đang hiển thị (đã kẹp theo cửa sổ)
  var pinWant = 380 // chiều rộng người dùng chọn: không bị kẹp, để cửa sổ to lại thì khôi phục
  var htmlW0 = null // width gốc của <html> (giá trị + priority) trước khi nhường chỗ
  var unread = 0
  var entries = [] // lịch sử hội thoại của origin này
  var perms = [] // yêu cầu xin quyền của agent đang chờ bạn quyết định
  var connecting = null
  var sseKey = null // khóa chỉ mở /api/events, nhận từ handshake

  // Ngôn ngữ giao diện: theo trình duyệt (vi* thì tiếng Việt, còn lại tiếng Anh); ép bằng window.__UIFB__.lang = 'vi' | 'en'.
  var LANG = ((window.__UIFB__ && window.__UIFB__.lang) || navigator.language || '').toLowerCase().indexOf('vi') === 0 ? 'vi' : 'en'
  function L(vi, en) { return LANG === 'vi' ? vi : en }
  var STATUS = LANG === 'vi'
    ? { queued: 'Đang chờ agent', delivered: 'Đã giao cho agent, chờ xác nhận', received: 'Agent đã đọc, đang xử lý', replied: 'Đã trả lời', expired: 'Agent không phản hồi' }
    : { queued: 'Waiting for the agent', delivered: 'Delivered, waiting for the agent to confirm', received: 'Agent read it, working', replied: 'Replied', expired: 'Agent did not respond' }

  // ---------- UI (shadow DOM để không lẫn với app) ----------
  var host = document.createElement('div')
  host.setAttribute('data-uifb', '1')
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font:13px/1.45 system-ui,Segoe UI,sans-serif}' +
    '.fab{position:fixed;right:14px;bottom:14px;pointer-events:auto;display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:99px;border:1px solid #c9ced8;background:#fff;color:#1d2433;cursor:pointer;box-shadow:0 2px 8px #0003;opacity:.9}' +
    '.fab:hover,.fab.on{opacity:1}.fab.on{background:#f9f6e7;color:#1d2433;border-color:#f9f6e7}' +
    '.badge{display:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#b3261e;color:#fff;font-size:11px;line-height:18px;text-align:center}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:#9aa3b5}.dot.live{background:#22a06b}.dot.work{background:#e0a100;animation:pulse 1.2s ease-in-out infinite}' +
    '@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}@keyframes bounce{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}' +
    '.typing{align-self:flex-start;display:flex;align-items:center;gap:8px;background:#eef1f7;border-radius:10px;border-bottom-left-radius:3px;padding:8px 12px;color:#5d6678;white-space:nowrap;max-width:100%}' +
    '.typing .d{width:6px;height:6px;border-radius:50%;background:#8a93a6;animation:bounce 1.2s infinite}.typing .d:nth-child(2){animation-delay:.15s}.typing .d:nth-child(3){animation-delay:.3s}' +
    '@media (prefers-reduced-motion:reduce){.dot.work,.typing .d{animation:none;opacity:1}}' +
    '.box{position:fixed;border:2px solid #e0b100;background:#f9f6e755;border-radius:3px;display:none}' +
    '.tag{position:fixed;background:#f9f6e7;color:#1d2433;border:1px solid #e0b100;padding:1px 6px;border-radius:3px;font-size:11px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}' +
    '.chat{position:fixed;right:14px;bottom:56px;width:360px;max-width:calc(100vw - 28px);height:min(480px,calc(100vh - 80px));pointer-events:auto;display:none;flex-direction:column;background:#fff;color:#1d2433;border:1px solid #c9ced8;border-radius:12px;box-shadow:0 8px 30px #0004;overflow:hidden}' +
    '.chat.open{display:flex}' +
    '.chat.pin{top:0!important;right:0!important;bottom:0!important;left:auto!important;width:var(--pw,380px)!important;height:100vh!important;max-width:none!important;border-radius:0;border-width:0 0 0 1px;box-shadow:-2px 0 12px #0002}' +
    '.chat.pin .rz{display:none}' +
    '.rzw{display:none;position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2;touch-action:none}.chat.pin .rzw{display:block}.rzw:hover,.rzw.on{background:#f9f6e799}' +
    '.hd{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid #e3e6ee;background:#f6f7fa;white-space:nowrap}' +
    '.hd .lr{flex:none;display:flex;align-items:center;border:1px solid #c9ced8;background:#fff;color:#1d2433;border-radius:6px;padding:4px 6px;cursor:pointer;line-height:0}.hd .lr[hidden]{display:none}.hd .lr input{position:absolute;opacity:0;width:0;height:0;margin:0}.hd .lr svg{display:block;pointer-events:none}.hd .lr.on{background:#f9f6e7;border-color:#ecd58a}' +
    '.hd .t{font-weight:600;flex:none}.hd .pres{font-size:11px;color:#5d6678;margin-right:auto;display:flex;align-items:center;gap:5px;min-width:0}.hd .ptxt{overflow:hidden;text-overflow:ellipsis;min-width:0}.hd .ptxt[hidden]{display:none}.hd .pic{display:flex;line-height:0}.hd .pic[hidden],.hd .dot[hidden]{display:none}.hd .pic.live{color:#22a06b}.hd .pic.work{color:#e0a100}.hd .pic .spin{animation:spin 1s linear infinite}.hd button{flex:none}' +
    '.stale{position:relative;margin:4px 0 8px;padding:8px 26px 8px 10px;border:1px solid #ecd58a;background:#fdf9ea;border-radius:8px;font-size:12px;color:#5d4a00;display:flex;flex-direction:column;gap:6px;align-items:flex-start}' +
    '.stale button.x{position:absolute;top:4px;right:4px;border:0;background:none;color:#8a7420;font-size:15px;line-height:1;padding:2px 5px;border-radius:4px;cursor:pointer}.stale button.x:hover{background:#f3e8bd;color:#5d4a00}' +
    '.hd button.cp{font-size:11px;padding:1px 7px;border-color:#22a06b;color:#1a7f52}.hd button.cp:hover{background:#e7f6ef}.hd button.cp[hidden]{display:none}' +
    'button.b{border:1px solid #c9ced8;background:#fff;color:#1d2433;border-radius:6px;padding:3px 9px;cursor:pointer}' +
    'button.b:hover{background:#eef1f7}button.b.p{background:#f9f6e7;border-color:#ecd58a;color:#1d2433}button.b.p:disabled{opacity:.5;cursor:default}' +
    'button.b svg{display:block;pointer-events:none}.hd button.b[data-a=pin],.hd button.b[data-a=clear],.hd button.b[data-a=measure]{padding:4px 6px;line-height:0}' +
    'button.b.on{background:#f9f6e7;color:#1d2433;border-color:#ecd58a}' +
    // Nút có icon và chữ (.ib): mọi màn hình chỉ hiện icon cho đồng nhất; chữ nằm trong aria-label/title (trình đọc màn hình, tooltip).
    'button.b.ib .bt{display:none}button.b.ib{padding:5px 9px;line-height:0}.row button.b{min-height:30px}' +
    // Vừa chép xong (.done): đổi icon thành dấu tích trên nền xanh trong 2 giây, vì chữ "Đã chép ✓" bị ẩn.
    'button.b .ok{display:none}button.b.done .ok{display:block}button.b.done .ic{display:none}.hd button.b.done,.hd button.b.done:hover{background:#22a06b;border-color:#22a06b;color:#fff}' +
    '.list{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:9px;background:#fff}' +
    '.list{scrollbar-width:thin;scrollbar-color:transparent transparent}.list:hover{scrollbar-color:#c9ced8 transparent}' +
    '.list::-webkit-scrollbar{width:6px}.list::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}.list:hover::-webkit-scrollbar-thumb{background:#c9ced8}' +
    '.rz{position:absolute;left:0;top:0;width:16px;height:16px;cursor:nwse-resize;z-index:1;touch-action:none;background:linear-gradient(135deg,#8a93a688 0 2px,transparent 2px 4px,#8a93a688 4px 6px,transparent 6px)}' +
    '.perm{align-self:stretch;border:1px solid #e0a100;background:#fff8e6;border-radius:10px;padding:9px 10px;color:#1d2433}.perm .ph{font-weight:600;margin-bottom:4px}' +
    '.perm pre{margin:4px 0 8px;max-height:140px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #ecd9a6;border-radius:6px;padding:6px;font:11.5px/1.4 ui-monospace,Consolas,monospace}.perm .pw{font-size:11px;color:#5d6678;margin-bottom:6px}.perm .pb{display:flex;gap:6px;justify-content:flex-end}' +
    'button.b.ok{background:#1e7a4a;border-color:#1e7a4a;color:#fff}button.b.no{color:#b3261e;border-color:#e5b5b1}' +
    '.empty{margin:auto;text-align:center;color:#8a93a6;padding:0 14px}' +
    '.g{display:flex;flex-direction:column;max-width:88%}.g.u{align-self:flex-end;align-items:flex-end}.g.a{align-self:flex-start;align-items:flex-start}' +
    '.m{max-width:100%;padding:7px 10px;border-radius:10px;overflow-wrap:anywhere;white-space:pre-wrap}' +
    '.m.u{background:#f9f6e7;color:#1d2433;border-bottom-right-radius:3px}' +
    '.m.a{background:#eef1f7;border-bottom-left-radius:3px}' +
    '.meta{font-size:11px;margin-top:3px;color:#5d6678;white-space:normal}.g.u .meta{text-align:right}' +
    '.chip{display:block;max-width:100%;margin-top:4px;padding:0 6px;border-radius:4px;background:#00000014;font:11px ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.st.replied{color:#1e7a4a}' +
    '.rs{margin-left:8px;padding:0;border:0;background:none;color:#8a5a00;font:inherit;cursor:pointer}.rs:hover{text-decoration:underline}.rs:disabled{opacity:.5;cursor:default}' +
    '.cmp{border-top:1px solid #e3e6ee;padding:8px;background:#f6f7fa}' +
    '.sel{display:none;flex-direction:column;gap:4px;margin-bottom:6px;max-height:150px;overflow-y:auto;font-size:12px;color:#1d2433}.sel.show{display:flex}' +
    '.sel{scrollbar-width:thin;scrollbar-color:transparent transparent}.sel:hover{scrollbar-color:#c9ced8 transparent}' +
    '.sel::-webkit-scrollbar{width:6px}.sel::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}.sel:hover::-webkit-scrollbar-thumb{background:#c9ced8}' +
    '.pk{display:flex;align-items:center;gap:5px}.pk button.b{padding:1px 7px}' +
    '.pk .ref{flex:none;min-width:22px;height:20px;padding:0 5px;border:0;border-radius:5px;background:#e0b100;color:#1d2433;font-weight:700;font-size:11px;cursor:pointer}.pk .ref:hover{background:#c99f00}' +
    '.sel .lbl{flex:0 1 42%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#f9f6e7;border-radius:5px;padding:2px 7px}' +
    '.pk input{flex:1;min-width:0;border:1px solid #c9ced8;border-radius:5px;padding:2px 6px;color:#1d2433;background:#fff;font-size:12px}' +
    '.box.bm{background:none}' +
    '.bmm,.bmp,.bmi{position:fixed;display:none;pointer-events:none}.bmm{border-style:solid;border-color:#f6a24f8c}.bmp{border-style:solid;border-color:#7cc47c8c;background:#6fa8dc59;background-clip:content-box}' +
    '.bmi{background:#1d2433;color:#fff;padding:3px 7px;border-radius:4px;font:11px/1.4 ui-monospace,Consolas,monospace;white-space:pre;box-shadow:0 1px 4px #0005}.bmi b{font-weight:700;color:#ffd666}' +
    '.mko{position:fixed;display:none;border:2px dashed #e0b100;border-radius:3px;pointer-events:none}' +
    '.mkb{position:fixed;display:none;min-width:18px;height:18px;padding:0 4px;border:0;border-radius:9px;background:#e0b100;color:#1d2433;font:700 11px/18px system-ui,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 1px 3px #0006}' +
    '.en{margin-top:4px;font-size:12px;white-space:pre-wrap}' +
    '.att{display:none;gap:6px;flex-wrap:wrap;margin-bottom:6px}.att.show{display:flex}' +
    '.th{position:relative;width:52px;height:52px;border:1px solid #c9ced8;border-radius:6px;overflow:hidden;background:#fff}.th img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.th button{position:absolute;top:2px;right:2px;width:16px;height:16px;padding:0;border:0;border-radius:8px;background:#1d2433cc;color:#fff;font:12px/16px system-ui,sans-serif;cursor:pointer}' +
    '.th button.tk{top:auto;right:auto;left:0;bottom:0;width:auto;height:14px;padding:0 4px;border-radius:0 4px 0 0;font-size:10px;line-height:14px}' +
    '.ims{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}.ims a,.ims span{display:block;width:64px;height:48px;border-radius:5px;overflow:hidden;background:#00000014}.ims img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.ims span{font-size:10px;line-height:1.2;padding:3px;color:#5b6475;box-sizing:border-box}' +
    '.cmp.drop{outline:2px dashed #e0b100;outline-offset:-4px}' +
    'textarea{width:100%;height:58px;resize:none;border:1px solid #c9ced8;border-radius:6px;padding:6px;color:#1d2433;background:#fff}' +
    '.row{display:flex;gap:6px;justify-content:flex-end;margin-top:6px;align-items:center}.row .msg{flex:1;font-size:11px;line-height:1.3;color:#b3261e;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}.row button{flex:none;white-space:nowrap}' +
    '</style>' +
    '<div class="mks"></div><div class="hbm"></div><div class="box"></div><div class="tag"></div>' +
    '<div class="chat"><div class="rz" title="' + L('Kéo để đổi kích thước', 'Drag to resize') + '"></div><div class="rzw" title="' + L('Kéo để đổi chiều rộng', 'Drag to change the width') + '"></div><div class="hd"><span class="t">UI Feedback</span><span class="pres"><span class="dot"></span><span class="pic" role="img" hidden></span><span class="ptxt">' + L('Chưa kết nối', 'Not connected') + '</span><button class="b cp ib" data-a="connect" hidden title="' + L('Chưa có agent. Bấm để chép một câu lệnh, dán vào agent bất kỳ (Claude Code, Codex…) để agent kết nối và nhận phản hồi từ trang này', 'No agent yet. Click to copy a prompt; paste it into any agent (Claude Code, Codex…) to connect it to this page') + '" aria-label="' + L('Kết nối agent', 'Connect agent') + '"><svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg><svg class="ok" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span class="bt">' + L('Kết nối agent', 'Connect agent') + '</span></button></span>' +
    '<label class="lr" hidden title="' + L('Tự tải lại trang khi file của site thay đổi', 'Reload the page when site files change') + '" aria-label="' + L('Tự tải lại', 'Auto-reload') + '"><input type="checkbox" data-live><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></label><button class="b" data-a="measure" title="' + L('Hiện kích thước, padding, margin của phần tử đang trỏ và đã chọn', 'Show size, padding and margin of the hovered and picked elements') + '" aria-label="' + L('Đo phần tử', 'Measure elements') + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg></button><button class="b" data-a="pin" title="' + L('Ghim cố định bên phải trang (kéo mép trái để đổi chiều rộng)', 'Pin to the right edge (drag the left edge to resize)') + '" aria-label="' + L('Ghim', 'Pin') + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg></button><button class="b" data-a="clear" title="' + L('Xóa lịch sử hội thoại', 'Clear conversation history') + '" aria-label="' + L('Xóa lịch sử hội thoại', 'Clear conversation history') + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button><button class="b" data-a="close" title="' + L('Đóng', 'Close') + '">×</button></div>' +
    '<div class="list"></div>' +
    '<div class="cmp"><div class="sel"></div><div class="att"></div><input type="file" accept="image/*" multiple hidden data-file>' +
    '<textarea placeholder="' + L('Ghi chú: sai ở đâu? Dán ảnh bằng Ctrl+V (Ctrl+Enter để gửi)', 'Note: what is wrong? Paste images with Ctrl+V (Ctrl+Enter to send)') + '"></textarea>' +
    '<div class="row"><button class="b ib" data-a="pick" aria-label="' + L('Chọn phần tử', 'Pick element') + '" title="' + L('Chọn phần tử trên trang (Alt+Shift+K). Ctrl+click để chọn thêm nhiều phần tử', 'Pick an element on the page (Alt+Shift+K). Ctrl+click to add more elements') + '"><svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z"/></svg><span class="bt">' + L('Chọn phần tử', 'Pick element') + '</span></button><button class="b" data-a="multi" aria-pressed="false" title="' + L('Bật để mỗi lần chạm/click là THÊM một phần tử (thay cho Ctrl+click, dùng trên điện thoại)', 'Turn on so each tap/click ADDS an element (replaces Ctrl+click, for mobile)') + '">+</button><button class="b" data-a="attach" title="' + L('Đính kèm ảnh (hoặc dán Ctrl+V, kéo thả ảnh vào khung)', 'Attach images (or paste with Ctrl+V, drop images on the panel)') + '" aria-label="' + L('Đính kèm ảnh', 'Attach images') + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg></button><span class="msg"></span><button class="b p ib" data-a="send" aria-label="' + L('Gửi cho agent', 'Send to agent') + '" title="' + L('Gửi cho agent (Ctrl+Enter)', 'Send to agent (Ctrl+Enter)') + '"><svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/></svg><span class="bt">' + L('Gửi cho agent', 'Send to agent') + '</span></button></div></div></div>' +
    '<button class="fab" title="' + L('Mở khung chat phản hồi UI (Alt+Shift+H: ẩn/hiện)', 'Open the UI feedback chat (Alt+Shift+H: hide/show)') + '"><span class="dot"></span><span>Feedback</span><span class="badge"></span></button>'
  var $ = function (s) { return root.querySelector(s) }
  // Đọc/đổi chữ của nút. Nút có icon (.ib) giữ icon, chỉ đổi phần chữ và aria-label (chữ luôn ẩn, trình đọc màn hình vẫn đọc được).
  function btnText(btn, t) {
    var sp = btn.querySelector('.bt')
    if (t == null) return sp ? sp.textContent : btn.textContent
    if (sp) { sp.textContent = t; btn.setAttribute('aria-label', t) } else btn.textContent = t
  }
  var box = $('.box'), tag = $('.tag'), chat = $('.chat'), list = $('.list'), ta = $('textarea'), msg = $('.msg')
  var fab = $('.fab'), fabDot = $('.fab .dot'), badge = $('.badge'), pres = $('.pres .dot'), ptxt = $('.ptxt'), pic = $('.pic')
  var attBox = $('.att'), fileIn = $('[data-file]')
  // Thiết bị cảm ứng không có Ctrl+V/Ctrl+Enter: gợi ý ngắn, dán ảnh qua nút ảnh hoặc menu dán của bàn phím.
  try { if (window.matchMedia('(hover:none) and (pointer:coarse)').matches) ta.placeholder = L('Ghi chú: sai ở đâu?', 'Note: what is wrong?') } catch (_) {}
  var selBox = $('.sel'), mks = $('.mks'), cmp = $('.cmp'), pickBtn = $('[data-a="pick"]'), cpBtn = $('[data-a="connect"]')
  function mount() { (document.body || document.documentElement).appendChild(host) }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  // ---------- Kết nối bridge ----------
  // Gọi API của bridge kèm token. Gặp 401 (bridge chạy lại với token mới) thì bỏ token cũ, handshake lại và thử một lần.
  function api(path, init, noRetry) {
    init = init || {}
    var h = { authorization: 'Bearer ' + token }
    if (init.body) h['content-type'] = 'application/json'
    return fetch(BRIDGE + path, { method: init.method || 'GET', headers: h, body: init.body }).then(function (r) {
      if (r.status !== 401 || noRetry) return r
      resetAuth()
      return connect().then(function () { return api(path, init, true) })
    })
  }
  function resetAuth() {
    token = null; sseKey = null; connecting = null
    if (es) { es.close(); es = null }
  }
  function connect() {
    if (token) return Promise.resolve(token)
    if (connecting) return connecting
    connecting = fetch(BRIDGE + '/api/handshake' + (PAIR ? '?key=' + encodeURIComponent(PAIR) : '')).then(function (r) {
      if (!r.ok) { var e = new Error('handshake ' + r.status); e.status = r.status; throw e }
      return r.json()
    }).then(function (j) {
      token = j.token
      sseKey = j.sse || null
      bridgeImages = j.images === true
      // Bridge bản cũ (còn chạy nền từ trước khi nâng cấp) không có khóa SSE: báo rõ thay vì im lặng mất cập nhật trực tiếp.
      if (!sseKey) msg.textContent = L('Bridge đang chạy là bản cũ: chạy `tl-ui-feedback stop` rồi tải lại trang.', 'The running bridge is outdated: run `tl-ui-feedback stop`, then reload the page.')
      setPresence(j.listening)
      openEvents()
      return loadHistory().then(function () { return token })
    }).catch(function (e) { connecting = null; throw e })
    return connecting
  }
  function loadHistory() {
    return api('/api/history?origin=' + encodeURIComponent(location.origin), null, true) // không thử lại: chính connect() gọi hàm này
      .then(function (r) { return r.json() })
      .then(function (j) {
        entries = j.entries || []; perms = j.permissions || []; setPresence(j.listening)
        // Có thẻ xin quyền đang chờ từ trước khi trang nạp lại: phải hiện ngay, nếu không agent chờ tới hết hạn rồi hỏi ở terminal.
        if (perms.length) { if (hidden) toggleHidden(); if (!open) setOpen(true, true) }
        render(true)
      })
      .catch(function () {})
  }
  // Agent "đang làm việc" = có yêu cầu agent đã nhận (received) nhưng chưa trả lời.
  function isWorking() { return entries.some(function (e) { return e.role === 'user' && e.status === 'received' }) }
  // "Working" quá lâu: tin received cũ nhất mà từ lúc gửi (hoặc từ tin agent gần nhất) đã quá STALE_MS không có gì mới.
  var STALE_MS = (window.__UIFB__ && +window.__UIFB__.staleMs) || 3 * 60000 // staleMs: chỉ dùng cho test
  var staleDismissed = null // id tin mà người dùng đã đóng cảnh báo; tin khác quá hạn thì cảnh báo hiện lại
  function staleItem() {
    var w = null, last = 0
    entries.forEach(function (e) {
      var t = Date.parse(e.ts) || 0
      if (e.role === 'user' && e.status === 'received' && !w) w = e
      if (t > last) last = t
    })
    if (!w || perms.length) return null // đang có thẻ xin quyền: đó là lý do agent chờ
    var idle = Date.now() - last
    return idle >= STALE_MS ? { e: w, min: Math.floor(idle / 60000) } : null
  }
  // Câu nhắc cho agent (tiếng Anh) để người dùng dán vào terminal khi agent không còn poll.
  function nudgePrompt(id) {
    var e = entries.find(function (x) { return (x.itemId || x.id) === id }) || {}
    var o = location.origin
    return 'You received UI feedback ' + id + ' from ' + o + ' ("' + String(e.text || '').slice(0, 160) + '") but have not replied in the page, so it still shows "Agent is working". ' +
      'If you already answered or fixed it, send that answer now with tl_ui_feedback_reply (id ' + id + ') or `tl-ui-feedback reply "<answer>" --id ' + id + '`; text in your terminal never reaches me. ' +
      'If you are still working, send a short progress reply with origin ' + o + ' and finish first. ' +
      'Then poll again with origin ' + o + ' (tl_ui_feedback_poll or `tl-ui-feedback poll --origin ' + o + '`) and keep looping until I say stop.'
  }
  // Tự vẽ lại khi tin đang xử lý vượt ngưỡng (không có sự kiện nào kích hoạt render lúc đó).
  var staleKey = -1
  setInterval(function () {
    var s = staleItem(), k = s ? s.min : -1
    if (k !== staleKey) { staleKey = k; if (open) render() } // chỉ vẽ lại khi vào/ra trạng thái kẹt hoặc số phút đổi
  }, Math.min(30000, Math.max(500, STALE_MS / 2)))
  // Icon trạng thái agent ở header (lucide): tai = đang nghe, vòng xoay = đang làm, bàn tay = chờ cho phép.
  var PIC_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  var PIC = {
    live: PIC_SVG + '><path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/></svg>',
    work: PIC_SVG + ' class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    hand: PIC_SVG + '><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>'
  }
  function updateHeader() {
    var w = isWorking() || perms.length > 0
    var cls = 'dot' + (w ? ' work' : listening ? ' live' : '')
    fabDot.className = cls
    pres.className = cls
    var txt = perms.length ? L('Chờ bạn cho phép', 'Waiting for your approval') : w ? L('Agent đang làm việc…', 'Agent is working…') : listening ? L('Agent đang nghe', 'Agent is listening') : L('Chưa có agent', 'No agent yet')
    ptxt.textContent = txt
    cpBtn.hidden = w || listening
    // Có agent: chỉ hiện icon trạng thái (đồng nhất với các nút icon), chữ nằm ở tooltip/aria-label.
    // Chưa có agent: chấm xám + nút "Kết nối agent" đã đủ nghĩa. Lúc nào cũng ẩn chữ để header hẹp không bị cắt cụt.
    var ic = perms.length ? 'hand' : w ? 'work' : listening ? 'live' : ''
    if (pic.getAttribute('data-s') !== ic) { pic.setAttribute('data-s', ic); pic.innerHTML = ic ? PIC[ic] : '' }
    pic.className = 'pic' + (ic === 'live' ? ' live' : ic ? ' work' : '')
    pic.hidden = !ic; pres.hidden = !!ic; ptxt.hidden = true
    pic.setAttribute('aria-label', txt); pic.parentNode.title = ic ? txt : ''
  }
  // Câu lệnh cho agent (tiếng Anh): nối vào trang ĐANG mở này, không chạy serve mới, không dừng serve của người khác.
  function connectPrompt() {
    var o = location.origin
    return 'Use the tl-ui-feedback skill to take UI feedback from the page ' + o + ', which is already open (do not start or stop a serve). ' +
      'Set ORIGIN = ' + o + ' and run the feedback loop: poll with origin ' + o + ' (MCP tool tl_ui_feedback_poll, or `tl-ui-feedback poll --origin ' + o + '`), ' +
      'fix the code for each note, reply with tl_ui_feedback_reply (or `tl-ui-feedback reply`) using the same origin, then poll again. Keep looping until I say stop.'
  }
  function copyText(s) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s)
    return new Promise(function (ok, no) {
      var t = document.createElement('textarea')
      t.value = s; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      root.appendChild(t); t.select()
      var done = false
      try { done = document.execCommand('copy') } catch (_) {}
      root.removeChild(t)
      done ? ok() : no(new Error('copy'))
    })
  }
  function copyPrompt(btn, text, okMsg) {
    // Bấm lại khi đang hiện "Đã chép": giữ chữ gốc đã lưu, không lưu nhầm chữ "Đã chép".
    var label = btn._label || (btn._label = btnText(btn))
    clearTimeout(btn._done)
    copyText(text).then(function () {
      btnText(btn, L('Đã chép ✓', 'Copied ✓')); btn.classList.add('done')
      msg.textContent = okMsg
    }, function () {
      // Trình duyệt chặn clipboard: đưa câu lệnh vào ô ghi chú để người dùng tự chép, nhưng chỉ khi ô đang trống
      // (không ghi đè bản nháp); có bản nháp thì hiện trong hộp thoại prompt (chữ đã được chọn sẵn để chép).
      if (!ta.value.trim()) {
        ta.value = text; ta.focus(); ta.select()
        msg.textContent = L('Không chép được: câu lệnh đang ở ô ghi chú, hãy tự chép (Ctrl+C).', 'Could not copy: the prompt is in the note box, copy it yourself (Ctrl+C).')
      } else {
        window.prompt(L('Không chép được tự động. Chép câu lệnh này (Ctrl+C):', 'Could not copy automatically. Copy this prompt (Ctrl+C):'), text)
        msg.textContent = ''
      }
    })
    btn._done = setTimeout(function () { btnText(btn, label); btn.classList.remove('done'); btn._label = null }, 2000)
  }
  function copyConnect() { copyPrompt(cpBtn, connectPrompt(), L('Đã chép câu lệnh: dán vào agent để kết nối.', 'Prompt copied: paste it into an agent to connect.')) }
  function setPresence(on) {
    listening = !!on
    updateHeader()
    if (open) render()
  }
  function mine(e) { return !e.origin || e.origin === location.origin }
  function openEvents() {
    if (es || !sseKey) return
    // Khóa SSE riêng (chỉ mở được luồng sự kiện), không đưa token chính lên URL.
    es = new EventSource(BRIDGE + '/api/events?sse=' + encodeURIComponent(sseKey))
    // Nối lại sau khi rớt (bridge khởi động lại, máy ngủ dậy): sự kiện `permission` phát trong lúc rớt đã mất,
    // phải nạp lại lịch sử để thẻ xin quyền đang chờ hiện lên, nếu không agent chờ tới hết hạn rồi hỏi ở terminal.
    var opened = false
    es.onopen = function () { if (opened) loadHistory(); opened = true }
    // Lỗi mạng thì EventSource tự nối lại; bị từ chối hẳn (401 do token đổi) thì CLOSED: handshake lại.
    es.onerror = function () {
      if (es && es.readyState === 2) { resetAuth(); setPresence(false); setTimeout(autoConnect, 1000) }
    }
    es.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data) } catch (_) { return }
      if (d.type === 'presence') setPresence(d.origins ? d.any || d.origins.indexOf(location.origin) >= 0 : d.listening)
      else if (d.type === 'clear') {
        if (!d.origin || d.origin === location.origin) { entries = entries.filter(function (e) { return d.origin && e.origin === '' }); render() } // tin origin '' dùng chung, server giữ lại
      } else if (d.type === 'permission') {
        if (d.perm && d.perm.origins.indexOf(location.origin) >= 0 && !perms.some(function (x) { return x.id === d.perm.id })) {
          perms.push(d.perm)
          if (hidden) toggleHidden() // đang ẩn bằng Alt+Shift+H: phải hiện lại, nếu không thẻ Cho phép/Từ chối vô hình và agent chờ tới hết hạn
          if (!open) setOpen(true, true)
          render(true)
        }
      } else if (d.type === 'permission-done') {
        perms = perms.filter(function (x) { return x.id !== d.id }); render()
      } else if (d.type === 'message' && mine(d.entry)) {
        var i = entries.findIndex(function (x) { return x.id === d.entry.id })
        if (i >= 0) entries[i] = d.entry
        else {
          entries.push(d.entry)
          if (d.entry.role === 'agent' && !open) { unread++; updateBadge() }
        }
        render()
      } else if (d.type === 'status') {
        var e = entries.find(function (x) { return x.id === d.id })
        if (e) { e.status = d.status; e.unacked = d.unacked || 0; if (d.reminded) e.reminded = true; render() }
      }
    }
  }
  function updateBadge() {
    badge.style.display = unread > 0 ? 'inline-block' : 'none'
    badge.textContent = String(unread)
  }

  // ---------- Hiển thị hội thoại ----------
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) }
  function render(stick) {
    updateHeader()
    if (!open) return
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    list.textContent = ''
    if (!entries.length) {
      var em = document.createElement('div')
      em.className = 'empty'
      em.textContent = L('Chưa có hội thoại. Bấm "Chọn phần tử" rồi click vào phần UI cần sửa, hoặc gõ tin nhắn bên dưới.', 'No conversation yet. Press "Pick element" and click the part of the UI to fix, or type a message below.')
      list.appendChild(em)
    }
    entries.forEach(function (e) {
      var side = e.role === 'user' ? 'u' : 'a'
      var g = document.createElement('div')
      g.className = 'g ' + side
      var m = document.createElement('div')
      m.className = 'm ' + side
      if (e.text) {
        var t = document.createElement('div')
        t.textContent = e.text
        m.appendChild(t)
      }
      // Bridge mới gửi elements[] (nhãn + ghi chú riêng); bridge cũ chỉ có element.
      var els = e.elements && e.elements.length ? e.elements : e.element ? [e.element] : []
      els.forEach(function (x) {
        var tagged = els.length > 1 || x.note
        var c = document.createElement('span')
        c.className = 'chip'
        c.textContent = (tagged && x.ref ? '[' + x.ref + '] ' : '') + (x.label || '') + (x.file ? ' · ' + x.file.split('/').slice(-2).join('/') : '')
        c.title = x.file || ''
        m.appendChild(c)
        if (x.note) {
          var en = document.createElement('div')
          en.className = 'en'
          en.textContent = '[' + x.ref + '] ' + x.note
          m.appendChild(en)
        }
      })
      if (e.images && e.images.length) m.appendChild(entryImages(e))
      g.appendChild(m)
      var meta = document.createElement('div')
      meta.className = 'meta'
      var s = document.createElement('span')
      s.className = 'st' + (e.status === 'replied' ? ' replied' : '')
      s.textContent = hhmm(e.ts) + (e.role === 'user' && e.status ? ' · ' + (e.status === 'queued' && e.unacked ? L('Agent chưa xác nhận, đang chờ giao lại', 'Agent did not confirm, waiting to redeliver') : e.status === 'queued' && !listening ? L('Chưa có agent nghe, đang nằm trong hàng đợi', 'No agent listening yet, queued') : e.status === 'received' && e.reminded ? L('Agent quay lại chờ mà chưa trả lời, đã tự nhắc agent', 'The agent went back to waiting without replying; it was reminded') : STATUS[e.status] || e.status) : '')
      meta.appendChild(s)
      // Chỉ cho gửi lại khi tin đã có kết cục (đã trả lời / quá hạn), tránh tạo bản trùng khi agent đang xử lý.
      if (e.role === 'user' && (e.status === 'replied' || e.status === 'expired')) {
        var rs = document.createElement('button')
        rs.className = 'rs'
        rs.textContent = L('↻ Gửi lại', '↻ Resend')
        rs.title = L('Gửi lại tin này cho agent', 'Send this message to the agent again')
        rs.setAttribute('data-a', 'resend')
        rs.setAttribute('data-id', e.itemId || '')
        rs._text = e.text
        meta.appendChild(rs)
      }
      g.appendChild(meta)
      list.appendChild(g)
    })
    perms.forEach(function (p) {
      var c = document.createElement('div')
      c.className = 'perm'
      var h = document.createElement('div'); h.className = 'ph'; h.textContent = L('Agent xin quyền chạy: ', 'Agent asks to run: ') + p.tool
      var pre = document.createElement('pre'); pre.textContent = p.detail || L('(không có chi tiết)', '(no details)')
      var w = document.createElement('div'); w.className = 'pw'; w.textContent = (p.cwd ? L('Thư mục: ', 'Folder: ') + p.cwd + ' · ' : '') + L('hết hạn lúc ' + hhmm(p.expiresAt) + ' thì agent hỏi lại ở terminal', 'expires at ' + hhmm(p.expiresAt) + ', then the agent asks in the terminal')
      var bar = document.createElement('div'); bar.className = 'pb'
      ;[['deny', L('Từ chối', 'Deny'), 'no'], ['allow', L('Cho phép', 'Allow'), 'ok']].forEach(function (x) {
        var b = document.createElement('button'); b.className = 'b ' + x[2]; b.textContent = x[1]
        b.addEventListener('click', function (ev) {
          if (!ev.isTrusted) return
          decide(p.id, x[0], b)
        })
        bar.appendChild(b)
      })
      c.appendChild(h); c.appendChild(pre); c.appendChild(w); c.appendChild(bar)
      list.appendChild(c)
    })
    if (isWorking()) {
      var ty = document.createElement('div')
      ty.className = 'typing'
      ty.setAttribute('data-uifb-working', '1')
      ty.innerHTML = '<span class="d"></span><span class="d"></span><span class="d"></span>'
      var tt = document.createElement('span')
      tt.textContent = L('Agent đang xử lý…', 'Agent is working…')
      ty.appendChild(tt)
      list.appendChild(ty)
      var st = staleItem()
      if (st && staleDismissed !== (st.e.itemId || st.e.id)) {
        var hint = document.createElement('div')
        hint.className = 'stale'
        hint.setAttribute('data-uifb-stale', '1')
        var ht = document.createElement('div')
        ht.textContent = L('Đã ' + st.min + ' phút agent chưa phản hồi. Có thể agent đang chờ bạn duyệt ở terminal, đã dừng vòng lặp, hoặc đã trả lời trong terminal thay vì trên trang. Xem terminal của agent, hoặc chép lời nhắc rồi dán vào đó.',
          'No word from the agent for ' + st.min + ' min. It may be waiting for your approval in its terminal, have left the loop, or have answered in the terminal instead of the page. Check the agent\'s terminal, or copy a reminder and paste it there.')
        var nb = document.createElement('button')
        nb.className = 'b'
        nb.setAttribute('data-a', 'nudge')
        nb.setAttribute('data-id', st.e.itemId || st.e.id)
        nb.textContent = L('Chép lời nhắc', 'Copy reminder')
        var xb = document.createElement('button')
        xb.className = 'x'
        xb.setAttribute('data-a', 'unstale')
        xb.setAttribute('data-id', st.e.itemId || st.e.id)
        xb.title = L('Đóng', 'Close')
        xb.setAttribute('aria-label', xb.title)
        xb.textContent = '×'
        hint.appendChild(xb); hint.appendChild(ht); hint.appendChild(nb)
        list.appendChild(hint)
      }
    }
    if (atBottom || stick || !render.once) list.scrollTop = list.scrollHeight
    render.once = true
  }
  // Chỉ click thật của người dùng (isTrusted) mới quyết định được; trang không tự duyệt bằng click giả.
  function decide(id, decision, btn) {
    btn.disabled = true
    api('/api/permission/decide', { method: 'POST', body: JSON.stringify({ id: id, decision: decision }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok && r.status !== 409) throw new Error(j.error || r.status) }) })
      .then(function () { perms = perms.filter(function (x) { return x.id !== id }); render() })
      .catch(function (e) { btn.disabled = false; msg.textContent = L('Không gửi được quyết định: ', 'Could not send the decision: ') + e.message })
  }
  // Alt+Shift+H: ẩn/hiện toàn bộ overlay (nút + khung chat) để chụp màn hình hoặc xem trang không bị che.
  var hidden = false
  function toggleHidden() {
    hidden = !hidden
    if (hidden && picking) stopPicking()
    host.style.display = hidden ? 'none' : ''
    applyPin()
    // Đang ghim: hiện lại overlay thì mở luôn khung chat (không chỉ nút Feedback), không tự bật chế độ chọn.
    if (!hidden && pinned && !open) setOpen(true, true)
  }
  function setOpen(v, noPick) {
    open = v
    chat.classList.toggle('open', v)
    fab.classList.toggle('on', v)
    applyPin()
    if (!v && picking) stopPicking()
    placeMarks() // huy hiệu chỉ hiện khi khung chat mở
    if (v) {
      unread = 0
      updateBadge()
      connect().then(function () { clampChat(); render(); list.scrollTop = list.scrollHeight; if (open && !noPick && !picking && !picks.length) startPicking() }).catch(function (e) {
        list.textContent = ''
        var em = document.createElement('div')
        em.className = 'empty'
        // 403: site ngoài localhost chưa được allow (bridge chặn cả CORS nên fetch lỗi mạng), hoặc thiếu/sai khóa ghép cặp.
        em.textContent = e && e.status === 403
          ? L('Bridge từ chối trang này. Chạy: tl-ui-feedback allow ', 'The bridge refused this page. Run: tl-ui-feedback allow ') + location.origin + L(' rồi mở trang bằng bookmarklet lệnh đó in ra.', ' and open the page with the bookmarklet it prints.')
          : L('Không kết nối được bridge (', 'Cannot reach the bridge (') + BRIDGE + L('). Chạy: tl-ui-feedback start', '). Run: tl-ui-feedback start') +
            (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(location.origin) ? '' : L('. Site ngoài localhost cần: tl-ui-feedback allow ', '. A site outside localhost needs: tl-ui-feedback allow ') + location.origin +
              L(', và cho phép trang truy cập mạng cục bộ khi trình duyệt hỏi (biểu tượng ổ khóa → Quyền).', ', and the page must be allowed to access the local network when the browser asks (padlock icon → Permissions).'))
        list.appendChild(em)
      })
      render()
    }
  }

  // ---------- Trích xuất thông tin phần tử ----------
  function nameOf(t) {
    return t && (t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && nameOf(t.type))) || null
  }
  function fiberOf(el) {
    var k = Object.keys(el).find(function (x) { return x.indexOf('__reactFiber$') === 0 })
    return k ? el[k] : null
  }
  function cssPath(el) {
    var parts = []
    for (var n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      var tid = n.getAttribute('data-testid')
      if (tid) { parts.unshift('[data-testid="' + tid.replace(/"/g, '\\"') + '"]'); break }
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break }
      var s = n.tagName.toLowerCase()
      var p = n.parentElement
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName })
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'
      }
      parts.unshift(s)
    }
    return parts.join(' > ')
  }
  function extract(el) {
    var r = topRect(el)
    var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el)
    var isSecret = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
    var out = {
      element: {
        tag: el.tagName,
        testID: el.getAttribute('data-testid'),
        text: isSecret ? '' : (el.innerText || '').trim().slice(0, 120),
        selector: framePrefix(el.ownerDocument) + cssPath(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        style: {
          color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
          padding: cs.padding, margin: cs.margin, border: cs.border, display: cs.display,
        },
      },
      components: [], stacks: [], debugSources: [],
    }
    var f = fiberOf(el)
    for (var g = f, i = 0; g && i < 14; g = g.return, i++) {
      var n = typeof g.type !== 'string' ? nameOf(g.type) : null
      if (n && out.components.length < 14) out.components.push(n)
      if (i < 10 && g._debugStack && g._debugStack.stack) {
        out.stacks.push({ comp: n || (typeof g.type === 'string' ? g.type : String(g.tag)), lines: String(g._debugStack.stack).split('\n').slice(1, 14) })
      }
      // React 18 dev: JSX dev transform ghi sẵn file:dòng, bridge dùng thẳng, không cần source map.
      var ds = g._debugSource
      if (i < 10 && ds && typeof ds.fileName === 'string') {
        out.debugSources.push({ comp: n || (typeof g.type === 'string' ? g.type : String(g.tag)), file: ds.fileName, line: ds.lineNumber, column: ds.columnNumber })
      }
    }
    return out
  }

  // ---------- Chọn phần tử ----------
  // iframe cùng origin: đi sâu vào contentDocument (kể cả lồng nhau); iframe khác origin không truy cập được nên chọn chính thẻ <iframe>.
  function frameDoc(f) { try { return f.contentDocument } catch (_) { return null } }
  // iframe có thể bị co/giãn bằng CSS transform (vd khung xem trước thu nhỏ): tỉ lệ = kích thước hiển thị / kích thước bố cục
  // Điểm gốc vùng nội dung của iframe (sau viền và padding), tính theo px bố cục
  function frameInset(f) {
    var cs = null
    try { cs = (f.ownerDocument.defaultView || window).getComputedStyle(f) } catch (_) {}
    return { x: f.clientLeft + (cs ? parseFloat(cs.paddingLeft) || 0 : 0), y: f.clientTop + (cs ? parseFloat(cs.paddingTop) || 0 : 0) }
  }
  function frameScale(f, r) { return { x: f.offsetWidth ? r.width / f.offsetWidth : 1, y: f.offsetHeight ? r.height / f.offsetHeight : 1 } }
  function elementAt(x, y) {
    var el = document.elementFromPoint(x, y)
    while (el && el.tagName === 'IFRAME') {
      var cd = frameDoc(el)
      if (!cd) break
      var r = el.getBoundingClientRect(), sc = frameScale(el, r)
      var ins = frameInset(el)
      x = (x - r.left) / sc.x - ins.x; y = (y - r.top) / sc.y - ins.y
      var inner = cd.elementFromPoint(x, y)
      if (!inner) break
      el = inner
    }
    if (el && el.tagName !== 'IFRAME') el = underNoneEvents(el, x, y)
    return el && el !== host && !host.contains(el) ? el : null
  }
  // elementFromPoint bỏ qua phần tử pointer-events:none (vd lớp phụ đề đè lên trang; lớp này có thể là anh em chứ không phải tổ tiên của phần tử trúng).
  // Cách làm: gom các phần tử pointer-events:none đang hiện tại điểm đó, tạm bật pointer-events cho chúng để elementsFromPoint cho đúng thứ tự xếp chồng,
  // rồi lấy phần tử trên cùng có nội dung hiển thị (bỏ qua lớp phủ rỗng: không chữ, không nền, không viền).
  function hasPaint(k, cs) {
    // SVG: chỉ hình/chữ thật sự vẽ ra mới tính; <svg>/<g> chỉ là khung chứa (bbox của chúng phủ cả vùng trống)
    if (k.namespaceURI !== 'http://www.w3.org/1999/xhtml') return /^(path|rect|circle|ellipse|line|polyline|polygon|text|image|use|foreignObject)$/.test(k.localName)
    if (/^(IMG|CANVAS|VIDEO|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(k.tagName)) return true
    for (var n = k.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true
    if (cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true
    if (cs.backgroundColor && !/^rgba\(.*,\s*0\)$|^transparent$/.test(cs.backgroundColor)) return true
    return ['Top', 'Right', 'Bottom', 'Left'].some(function (sd) { return parseFloat(cs['border' + sd + 'Width']) > 0 && cs['border' + sd + 'Style'] !== 'none' })
  }
  function faded(k, win) { // tổ tiên opacity:0 (đang mờ dần ra) thì con cũng không nhìn thấy
    for (var n = k.parentElement; n; n = n.parentElement) if (+win.getComputedStyle(n).opacity === 0) return true
    return false
  }
  // Danh sách phần tử pointer-events:none của mỗi document, quét MỘT lần rồi dùng lại cho mọi lần rê chuột (trước đây quét cả
  // document ở mỗi khung hình). MutationObserver đánh dấu "bẩn" khi DOM/class/style đổi; quét lại tối đa 4 lần/giây.
  // Bộ nhớ đệm bị xóa khi tắt chế độ chọn. Document quá lớn (> 30000 phần tử) thì bỏ qua bước này như trước.
  var pev = [] // [{doc, list, at, dirty, mo}]
  function pevEntry(doc) { for (var i = 0; i < pev.length; i++) if (pev[i].doc === doc) return pev[i]; return null }
  function pevReset() { pev.forEach(function (c) { if (c.mo) c.mo.disconnect() }); pev = [] }
  function noneEventEls(doc, win) {
    var c = pevEntry(doc), now = Date.now()
    if (c && !(c.dirty && now - c.at >= 250)) return c.list
    if (!c) {
      c = { doc: doc, list: [], at: 0, dirty: true, mo: null }
      if (typeof MutationObserver === 'function') {
        c.mo = new MutationObserver(function () { c.dirty = true })
        c.mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled'] })
      }
      pev.push(c)
    }
    var all = doc.getElementsByTagName('*'), list = []
    if (all.length <= 30000) {
      for (var i = 0; i < all.length; i++) {
        var k = all[i]
        if (k === host || k.tagName === 'HTML' || k.tagName === 'BODY') continue
        if (win.getComputedStyle(k).pointerEvents === 'none') list.push(k)
      }
    }
    c.list = list; c.at = now; c.dirty = !c.mo // không có MutationObserver: coi như luôn bẩn, quét lại theo nhịp 250 ms
    return list
  }
  function underNoneEvents(el, x, y) {
    var doc = el.ownerDocument, win = doc.defaultView, pool = noneEventEls(doc, win), cand = []
    for (var i = 0; i < pool.length; i++) {
      var k = pool[i]
      if (!k.isConnected) continue
      var r = k.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0 || x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue
      var cs = win.getComputedStyle(k)
      if (cs.pointerEvents === 'none' && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0 && !faded(k, win)) cand.push(k)
    }
    if (!cand.length) return el
    var saved = cand.map(function (k) { return [k.style.getPropertyValue('pointer-events'), k.style.getPropertyPriority('pointer-events')] })
    var list, c = pevEntry(doc), wasDirty = c && c.dirty
    try {
      cand.forEach(function (k) { k.style.setProperty('pointer-events', 'auto', 'important') })
      list = doc.elementsFromPoint(x, y)
    } finally {
      cand.forEach(function (k, i) { if (saved[i][0]) k.style.setProperty('pointer-events', saved[i][0], saved[i][1]); else k.style.removeProperty('pointer-events') })
      // Thay đổi style tạm của chính mình không phải thay đổi của site: đừng để nó buộc quét lại.
      if (c && c.mo) { c.mo.takeRecords(); c.dirty = wasDirty }
    }
    for (var j = 0; j < list.length; j++) {
      var t = list[j]
      if (t === host || host.contains(t)) continue
      if (cand.indexOf(t) < 0) return t
      if (hasPaint(t, win.getComputedStyle(t))) return t
    }
    return el
  }
  // Phép biến đổi từ toạ độ của document trong iframe sang viewport trang chính: top = x + sx * local
  function frameXform(doc) {
    var t = { x: 0, y: 0, sx: 1, sy: 1 }
    for (var w = doc && doc.defaultView; w && w !== window; w = w.parent) {
      var f = null
      try { f = w.frameElement } catch (_) { break }
      if (!f) break
      var r = f.getBoundingClientRect(), sc = frameScale(f, r), ins = frameInset(f)
      t = { x: r.left + sc.x * (ins.x + t.x), y: r.top + sc.y * (ins.y + t.y), sx: sc.x * t.sx, sy: sc.y * t.sy }
    }
    return t
  }
  function topRect(el) {
    var r = el.getBoundingClientRect(), t = frameXform(el.ownerDocument)
    return { left: t.x + t.sx * r.left, top: t.y + t.sy * r.top, x: t.x + t.sx * r.x, y: t.y + t.sy * r.y, width: r.width * t.sx, height: r.height * t.sy }
  }
  function framePrefix(doc) {
    var parts = []
    for (var w = doc && doc.defaultView; w && w !== window; w = w.parent) {
      var f = null
      try { f = w.frameElement } catch (_) { break }
      if (!f) break
      parts.unshift(cssPath(f))
    }
    return parts.length ? parts.join(' >>> ') + ' >>> ' : ''
  }
  // Toạ độ sự kiện (trong iframe là toạ độ của iframe) quy về viewport trang chính
  function evPoint(e, t) {
    var d = (e.view && e.view.document) || (e.target && (e.target.ownerDocument || e.target)) || document
    var o = d === document ? { x: 0, y: 0, sx: 1, sy: 1 } : frameXform(d), q = t || e
    return { x: o.x + o.sx * q.clientX, y: o.y + o.sy * q.clientY }
  }
  // ---------- Đo phần tử (box model kiểu DevTools): margin cam, padding xanh lá, nội dung xanh dương + nhãn số đo ----------
  var MEASURE_KEY = 'uifb.measure', measureOn = false
  try { measureOn = localStorage.getItem(MEASURE_KEY) === '1' } catch (_) {}
  function makeBM(parent) {
    var bm = {}
    ;['bmm', 'bmp', 'bmi'].forEach(function (c) { var d = document.createElement('div'); d.className = c; parent.appendChild(d); bm[c] = d })
    return bm
  }
  function hideBM(bm) { if (bm) bm.bmm.style.display = bm.bmp.style.display = bm.bmi.style.display = 'none' }
  function rmBM(bm) { if (bm) { bm.bmm.remove(); bm.bmp.remove(); bm.bmi.remove() } }
  function px(v) { return Math.round((parseFloat(v) || 0) * 10) / 10 }
  // Viết gọn 4 cạnh như shorthand CSS: "8", "8 12", "8 12 4", "8 12 4 2"
  function sides(a) {
    if (a[1] === a[3]) { if (a[0] === a[2]) return a[0] === a[1] ? '' + a[0] : a[0] + ' ' + a[1]; return a[0] + ' ' + a[1] + ' ' + a[2] }
    return a.join(' ')
  }
  function four(cs, pre, suf) { return ['top', 'right', 'bottom', 'left'].map(function (s) { return px(cs.getPropertyValue(pre + s + (suf || ''))) }) }
  function drawBM(bm, el) {
    var win = el.ownerDocument.defaultView, cs = win.getComputedStyle(el), br = el.getBoundingClientRect(), t = frameXform(el.ownerDocument)
    var m = four(cs, 'margin-'), p = four(cs, 'padding-'), b = four(cs, 'border-', '-width')
    var mc = m.map(function (v) { return Math.max(0, v) })
    var X = function (x) { return t.x + t.sx * x }, Y = function (y) { return t.y + t.sy * y }
    var ml = br.left - mc[3], mt = br.top - mc[0]
    bm.bmm.style.cssText = 'display:block;left:' + X(ml) + 'px;top:' + Y(mt) + 'px;width:' + t.sx * (br.width + mc[1] + mc[3]) + 'px;height:' + t.sy * (br.height + mc[0] + mc[2]) + 'px;border-width:' +
      t.sy * mc[0] + 'px ' + t.sx * mc[1] + 'px ' + t.sy * mc[2] + 'px ' + t.sx * mc[3] + 'px'
    bm.bmp.style.cssText = 'display:block;left:' + X(br.left + b[3]) + 'px;top:' + Y(br.top + b[0]) + 'px;width:' + Math.max(0, t.sx * (br.width - b[1] - b[3])) + 'px;height:' + Math.max(0, t.sy * (br.height - b[0] - b[2])) + 'px;border-width:' +
      t.sy * p[0] + 'px ' + t.sx * p[1] + 'px ' + t.sy * p[2] + 'px ' + t.sx * p[3] + 'px'
    var i = bm.bmi
    i.innerHTML = ''
    var w = document.createElement('b'); w.textContent = px(br.width) + ' × ' + px(br.height)
    i.appendChild(w)
    i.appendChild(document.createTextNode('\npadding ' + sides(p) + '\nmargin  ' + sides(m) + (b.some(Boolean) ? '\nborder  ' + sides(b) : '')))
    i.style.cssText = 'display:block;left:0;top:0;visibility:hidden'
    var iw = i.offsetWidth, ih = i.offsetHeight, bottom = Y(br.bottom + mc[2]), top = Y(mt)
    var y = bottom + 4 + ih <= window.innerHeight ? bottom + 4 : top - ih - 4 >= 0 ? top - ih - 4 : Math.max(0, window.innerHeight - ih)
    i.style.cssText = 'display:block;left:' + Math.max(0, Math.min(X(ml), window.innerWidth - iw)) + 'px;top:' + y + 'px'
  }
  var hbm = makeBM($('.hbm')), measureBtn = $('[data-a="measure"]')
  function applyMeasure() {
    measureBtn.classList.toggle('on', measureOn)
    box.classList.toggle('bm', measureOn)
    if (picking && current) drawBox(current); else hideBM(hbm)
    placeMarks()
  }
  function drawBox(el) {
    if (measureOn && el) drawBM(hbm, el); else hideBM(hbm)
    if (!el) { box.style.display = tag.style.display = 'none'; return }
    var r = topRect(el)
    box.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
    var f = fiberOf(el), label = el.tagName.toLowerCase()
    for (var g = f; g; g = g.return) { var n = typeof g.type !== 'string' && nameOf(g.type); if (n && n !== 'View' && n !== 'Text') { label = n + ' · ' + label; break } }
    tag.textContent = label + '  ' + Math.round(r.width) + '×' + Math.round(r.height) + (picks.length ? L('  ·  Ctrl+click: thêm', '  ·  Ctrl+click: add') : '')
    tag.style.cssText = 'display:block;left:' + Math.max(0, r.left) + 'px;top:' + Math.max(0, r.top - 20) + 'px'
  }
  var movePt = null, moveRaf = 0
  // Gộp mousemove theo khung hình: elementAt có thể phải quét cả document (underNoneEvents)
  function onMove(e) {
    if (!picking) return
    movePt = evPoint(e)
    if (moveRaf) return
    moveRaf = requestAnimationFrame(function () {
      moveRaf = 0
      if (!picking || !movePt) return
      current = elementAt(movePt.x, movePt.y); drawBox(current)
    })
  }
  function inHost(e) { return e.composedPath && e.composedPath().indexOf(host) >= 0 }
  function swallow(e) {
    if (!picking || inHost(e)) return
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
  }
  // Chế độ chọn giữ nguyên (tắt bằng Esc, nút hoặc Alt+Shift+K). Click thường: THAY phần tử đã chọn (như bản một phần tử), focus ô tin nhắn.
  // Ctrl+click (Cmd+click trên macOS): THÊM phần tử, focus ô ghi chú riêng của nó; click lại phần tử đã có thì chỉ focus ghi chú của nó.
  function pickEl(el, add) {
    if (!el) return
    if (!add) {
      if (!(picks.length === 1 && picks[0].el === el)) { clearPicks(); picks.push({ ref: REFS[0], el: el, data: extract(el), note: '' }); nextRef = 1; showSelected() }
      msg.textContent = ''
      ta.focus()
      return
    }
    for (var i = 0; i < picks.length; i++) if (picks[i].el === el) return focusPick(picks[i].ref)
    if (picks.length >= REFS.length) { msg.textContent = L('Tối đa ' + REFS.length + ' phần tử mỗi lần gửi.', 'At most ' + REFS.length + ' elements per message.'); return }
    var used = picks.map(function (p) { return p.ref }), ref = null
    for (var j = nextRef; j < REFS.length && !ref; j++) if (used.indexOf(REFS[j]) < 0) ref = REFS[j]
    for (var k = 0; k < REFS.length && !ref; k++) if (used.indexOf(REFS[k]) < 0) ref = REFS[k]
    nextRef = REFS.indexOf(ref) + 1
    picks.push({ ref: ref, el: el, data: extract(el), note: '' })
    msg.textContent = ''
    showSelected()
    focusPick(ref)
  }
  function onClick(e) {
    if (!picking || inHost(e)) return
    swallow(e)
    var p = evPoint(e)
    pickEl(elementAt(p.x, p.y) || current, e.ctrlKey || e.metaKey || multiOn)
  }
  // Cảm ứng (kể cả giả lập mobile của Chrome): touchstart/touchend gắn ở document bị Chrome coi là passive nên KHÔNG được preventDefault ở touchstart
  // (báo "[Intervention] Unable to preventDefault inside passive event listener"). Cách làm: touchstart/touchmove chỉ cập nhật khung và chặn lan ra site
  // (cho phép cuộn trang), còn touchend (đăng ký passive:false) chốt một cú chạm: chặn click giả của trình duyệt và chọn phần tử tại điểm chạm.
  var touchStart = null
  function touchPoint(e) { return (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || null }
  function onTouchStart(e) {
    if (!picking || inHost(e)) return
    var t = touchPoint(e)
    var p = t ? evPoint(e, t) : null
    touchStart = p
    if (p) { current = elementAt(p.x, p.y); drawBox(current) }
    e.stopPropagation(); e.stopImmediatePropagation()
  }
  function onTouchMove(e) {
    if (!picking || inHost(e)) return
    var t = touchPoint(e)
    var p = t ? evPoint(e, t) : null
    if (touchStart && p && Math.abs(p.x - touchStart.x) + Math.abs(p.y - touchStart.y) > 10) touchStart = null // kéo để cuộn, không phải chạm chọn
    e.stopPropagation(); e.stopImmediatePropagation()
  }
  function onTouchEnd(e) {
    if (!picking || inHost(e)) return
    e.stopPropagation(); e.stopImmediatePropagation()
    var t = touchPoint(e), tap = touchStart
    touchStart = null
    if (!tap || !t) return
    if (e.cancelable) e.preventDefault() // chặn click giả sau cú chạm để site không nhận
    var p = evPoint(e, t)
    pickEl(elementAt(p.x, p.y) || current, multiOn)
  }
  // Vẽ lại danh sách phần tử đã chọn (nhãn bấm để chèn [X], tên, ô ghi chú riêng, ×) và tạo huy hiệu cho phần tử mới.
  function showSelected() {
    selBox.textContent = ''
    picks.forEach(function (p) {
      var row = document.createElement('div')
      row.className = 'pk'
      row.setAttribute('data-ref', p.ref)
      var rb = document.createElement('button')
      rb.className = 'ref'; rb.textContent = p.ref
      rb.setAttribute('data-a', 'ref'); rb.setAttribute('data-ref', p.ref)
      rb.title = L('Chèn [' + p.ref + '] vào tin nhắn (Alt+' + p.ref + ')', 'Insert [' + p.ref + '] into the message (Alt+' + p.ref + ')')
      var lb = document.createElement('span')
      lb.className = 'lbl'
      lb.textContent = (p.data.components.slice(0, 3).join(' › ') || p.data.element.tag.toLowerCase()) + '  ·  ' + p.data.element.selector.slice(-50)
      lb.title = p.data.element.selector
      var inp = document.createElement('input')
      inp.type = 'text'; inp.maxLength = 1000; inp.value = p.note
      inp.placeholder = L('Ghi chú cho ' + p.ref + ' (tuỳ chọn)', 'Note for ' + p.ref + ' (optional)')
      inp.addEventListener('input', function () { p.note = inp.value })
      var x = document.createElement('button')
      x.className = 'b'; x.textContent = '×'
      x.setAttribute('data-a', 'unpick'); x.setAttribute('data-ref', p.ref)
      x.title = L('Bỏ phần tử ' + p.ref, 'Remove element ' + p.ref)
      row.appendChild(rb); row.appendChild(lb); row.appendChild(inp); row.appendChild(x)
      selBox.appendChild(row)
      if (!p.mk) {
        var o = document.createElement('div'); o.className = 'mko'
        var b = document.createElement('button'); b.className = 'mkb'; b.textContent = p.ref
        b.setAttribute('data-a', 'mark'); b.setAttribute('data-ref', p.ref)
        b.title = L('Sửa ghi chú cho ' + p.ref, 'Edit the note for ' + p.ref)
        var bm = makeBM(mks)
        mks.appendChild(o); mks.appendChild(b)
        p.mk = { o: o, b: b, bm: bm }
      }
    })
    selBox.classList.toggle('show', picks.length > 0)
    placeMarks()
  }
  function pickOf(ref) { for (var i = 0; i < picks.length; i++) if (picks[i].ref === ref) return picks[i]; return null }
  function focusPick(ref) {
    var inp = selBox.querySelector('.pk[data-ref="' + ref + '"] input')
    if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }) }
  }
  function unpick(ref) {
    var p = pickOf(ref)
    if (!p) return
    dropMk(p)
    picks.splice(picks.indexOf(p), 1)
    if (!picks.length) nextRef = 0
    showSelected()
  }
  function dropMk(p) { if (p.mk) { p.mk.o.remove(); p.mk.b.remove(); rmBM(p.mk.bm) } }
  function clearPicks() {
    picks.forEach(dropMk)
    picks = []; nextRef = 0
    showSelected()
  }
  // Chèn [X] tại vị trí con trỏ (hoặc thay đoạn đang bôi đen) của ô `f` — mặc định là tin nhắn chung.
  // Phát sự kiện input để ô ghi chú riêng cập nhật p.note như khi gõ tay.
  function insertRef(ref, f) {
    f = f || ta
    var s = f.selectionStart, e = f.selectionEnd, tok = '[' + ref + ']'
    if (s == null) { s = e = f.value.length }
    f.setRangeText(tok, s, e, 'end')
    f.dispatchEvent(new Event('input', { bubbles: true }))
    f.focus()
  }
  // Alt+A…J trong vùng soạn tin: chèn [A]…[J] của phần tử đã chọn vào ô đang gõ. Không có Shift/Ctrl/Meta
  // (Alt+Shift+K/H đã dùng; AltGr trên Windows là Ctrl+Alt nên gõ ký tự đặc biệt vẫn được).
  // Lấy chữ từ e.key; macOS Option+A cho e.key 'å' nên dùng e.code. Nhãn chưa được chọn thì để phím đi qua.
  function refKey(e) {
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return null
    var k = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : null)
    return k && picks.some(function (p) { return p.ref === k }) ? k : null
  }
  // Huy hiệu bám theo phần tử: đặt lại vị trí khi cuộn (mọi document đã gắn listener, kể cả iframe), đổi cỡ, và định kỳ (bố cục đổi).
  // Phần tử không còn trên trang (bị render lại/xoá) thì ẩn huy hiệu nhưng vẫn giữ dữ liệu đã trích để gửi.
  var markRaf = 0
  function placeMarks() {
    markRaf = 0
    picks.forEach(function (p) {
      if (!p.mk) return
      var r = open && p.el.isConnected && p.el.ownerDocument.defaultView ? topRect(p.el) : null
      if (!r || (!r.width && !r.height)) { p.mk.o.style.display = p.mk.b.style.display = 'none'; hideBM(p.mk.bm); return }
      if (measureOn) drawBM(p.mk.bm, p.el); else hideBM(p.mk.bm)
      p.mk.o.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
      p.mk.b.style.cssText = 'display:block;left:' + Math.max(0, r.left - 9) + 'px;top:' + Math.max(0, r.top - 9) + 'px'
    })
  }
  function scheduleMarks() { if (!markRaf && picks.length && open) markRaf = requestAnimationFrame(placeMarks) }
  window.addEventListener('resize', scheduleMarks)
  setInterval(scheduleMarks, 400)
  ta.addEventListener('input', function () { if (warnedNote !== null) { warnedNote = null; msg.textContent = '' } }) // sửa câu thì bỏ cảnh báo [X] cũ
  mks.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-a="mark"]') : null
    if (t) focusPick(t.getAttribute('data-ref'))
  })
  function startPicking() {
    picking = true; pickBtn.classList.add('on'); btnText(pickBtn, L('Đang chọn… (Esc)', 'Picking… (Esc)'))
    hookFrames(document); setCursor('crosshair')
  }
  function stopPicking() {
    picking = false; setMulti(false); pickBtn.classList.remove('on'); btnText(pickBtn, L('Chọn phần tử', 'Pick element'))
    setCursor('')
    drawBox(null)
    pevReset() // không giữ MutationObserver/bộ nhớ đệm khi không chọn
  }
  function setMulti(v) {
    multiOn = v
    var b = $('[data-a="multi"]'); b.classList.toggle('on', v); b.setAttribute('aria-pressed', v ? 'true' : 'false')
  }
  function togglePick() {
    if (picking) return stopPicking()
    if (!open) setOpen(true)
    connect().then(startPicking).catch(function () { msg.textContent = L('Không kết nối được bridge.', 'Cannot reach the bridge.') })
  }

  // ---------- Ảnh đính kèm ----------
  function b64(blob) {
    return new Promise(function (ok, no) {
      var r = new FileReader()
      r.onload = function () { ok(String(r.result).replace(/^data:[^,]*,/, '')) }
      r.onerror = function () { no(r.error) }
      r.readAsDataURL(blob)
    })
  }
  function loadImg(blob) {
    return new Promise(function (ok, no) {
      var u = URL.createObjectURL(blob), im = new Image()
      im.onload = function () { ok({ im: im, url: u }) }
      im.onerror = function () { URL.revokeObjectURL(u); no(new Error(L('không đọc được ảnh', 'cannot read the image'))) }
      im.src = u
    })
  }
  function toBlob(cv, type, q) { return new Promise(function (ok) { cv.toBlob(ok, type, q) }) }
  // Ảnh nhỏ, đúng định dạng thì gửi nguyên; còn lại vẽ lại qua canvas (cạnh dài ≤ MAX_ATT_SIDE), thử WebP rồi JPEG.
  function prepImage(file) {
    return loadImg(file).then(function (x) {
      var w = x.im.naturalWidth, h = x.im.naturalHeight
      var keep = /^image\/(png|jpeg|webp|gif)$/.test(file.type) && file.size <= MAX_ATT_BYTES && Math.max(w, h) <= MAX_ATT_SIDE
      if (keep) return b64(file).then(function (d) { return { data: d, mime: file.type, w: w, h: h, url: x.url } })
      var k = Math.min(1, MAX_ATT_SIDE / Math.max(w, h)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k))
      var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch
      var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch); cx.drawImage(x.im, 0, 0, cw, ch)
      URL.revokeObjectURL(x.url)
      return toBlob(cv, 'image/webp', 0.85).then(function (bl) {
        // Trình duyệt không hỗ trợ WebP trả PNG: dùng JPEG. Còn quá lớn thì giảm chất lượng.
        if (bl && bl.type === 'image/webp' && bl.size <= MAX_ATT_BYTES) return bl
        return toBlob(cv, 'image/jpeg', 0.85).then(function (j) { return j && j.size <= MAX_ATT_BYTES ? j : toBlob(cv, 'image/jpeg', 0.6) })
      }).then(function (bl) {
        if (!bl || bl.size > MAX_ATT_BYTES) throw new Error(L('ảnh quá lớn', 'image too large'))
        return b64(bl).then(function (d) { return { data: d, mime: bl.type, w: cw, h: ch, url: URL.createObjectURL(bl) } })
      })
    })
  }
  function addFiles(files) {
    var imgs = [].filter.call(files || [], function (f) { return f && /^image\//.test(f.type) })
    if (!imgs.length) { msg.textContent = L('Chỉ đính kèm được ảnh.', 'Only images can be attached.'); return }
    var room = MAX_ATT - atts.length - attPending
    msg.textContent = imgs.length > room ? L('Tối đa ' + MAX_ATT + ' ảnh mỗi tin.', 'At most ' + MAX_ATT + ' images per message.') : ''
    imgs.slice(0, Math.max(room, 0)).forEach(function (f) {
      attPending++
      prepImage(f).then(function (a) {
        attPending--
        if (atts.length >= MAX_ATT) { URL.revokeObjectURL(a.url); return }
        atts.push(a); showAtts()
      }).catch(function (e) { attPending--; msg.textContent = L('Không đính kèm được ảnh: ', 'Could not attach the image: ') + e.message })
    })
  }
  function showAtts() {
    attBox.textContent = ''
    attBox.classList.toggle('show', atts.length > 0)
    atts.forEach(function (a, i) {
      var th = document.createElement('span'); th.className = 'th'
      var im = document.createElement('img'); im.src = a.url; im.alt = 'img' + (i + 1)
      var tk = document.createElement('button'); tk.className = 'tk'; tk.textContent = 'img' + (i + 1); tk.setAttribute('data-a', 'atok'); tk.setAttribute('data-i', i)
      tk.title = L('Chèn [img' + (i + 1) + '] vào ghi chú', 'Insert [img' + (i + 1) + '] into the note')
      var x = document.createElement('button'); x.textContent = '×'; x.setAttribute('data-a', 'unatt'); x.setAttribute('data-i', i); x.title = L('Bỏ ảnh này', 'Remove this image')
      th.appendChild(im); th.appendChild(tk); th.appendChild(x); attBox.appendChild(th)
    })
  }
  // Bỏ một ảnh thì ảnh sau dồn lên (img3 thành img2): khác nhãn phần tử, vì [imgN] hiếm khi đã được gõ trước khi bỏ ảnh.
  function removeAtt(i) { var a = atts.splice(i, 1)[0]; if (a) URL.revokeObjectURL(a.url); showAtts() }
  function clearAtts() { atts.forEach(function (a) { URL.revokeObjectURL(a.url) }); atts = []; showAtts() }
  // Thumbnail trong lịch sử: lấy từ bridge (cần token) một lần rồi giữ objectURL.
  function entryImages(e) {
    var w = document.createElement('div'); w.className = 'ims'
    e.images.forEach(function (g) {
      var key = e.itemId + ':' + g.n, u = thumbs[key]
      if (e.imagesEvicted || u === 'gone') {
        var sp = document.createElement('span'); sp.textContent = '[img' + g.n + '] ' + L('không còn', 'gone'); w.appendChild(sp); return
      }
      var a = document.createElement('a'); a.target = '_blank'; a.rel = 'noopener'; a.title = 'img' + g.n + (g.w ? ' · ' + g.w + '×' + g.h : '')
      var im = document.createElement('img'); im.alt = 'img' + g.n
      a.appendChild(im); w.appendChild(a)
      if (u) { a.href = u; im.src = u; return }
      if (u === undefined) {
        thumbs[key] = null
        api('/api/image?id=' + encodeURIComponent(e.itemId) + '&n=' + g.n).then(function (r) {
          if (!r.ok) { var er = new Error(r.status); er.status = r.status; throw er }
          return r.blob()
        }).then(function (bl) { thumbs[key] = URL.createObjectURL(bl); render() })
          .catch(function (er) {
            // 404/410: bridge không còn ảnh. Lỗi khác (mạng, bridge đang khởi động lại) là tạm thời: thử lại sau, tối đa 3 lần.
            var tries = thumbTries[key] = (thumbTries[key] || 0) + 1
            if (er.status === 404 || er.status === 410 || tries >= 3) { thumbs[key] = 'gone'; render(); return }
            setTimeout(function () { delete thumbs[key]; render() }, 2000 * tries)
          })
      }
    })
    return w
  }
  // Dán ảnh vào ô ghi chú (chung hoặc riêng). Clipboard có cả chữ (copy từ Word/Excel) thì để dán chữ như thường.
  cmp.addEventListener('paste', function (e) {
    var dt = e.clipboardData
    if (!dt || [].indexOf.call(dt.types || [], 'text/plain') >= 0) return
    var files = [].map.call(dt.items || [], function (it) { return it.kind === 'file' ? it.getAsFile() : null }).filter(function (f) { return f && /^image\//.test(f.type) })
    if (!files.length) return
    e.preventDefault(); e.stopPropagation()
    addFiles(files)
  })
  var dragN = 0
  function hasFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0 }
  chat.addEventListener('dragenter', function (e) { if (hasFiles(e)) { e.preventDefault(); dragN++; cmp.classList.add('drop') } })
  chat.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } })
  chat.addEventListener('dragleave', function (e) { if (hasFiles(e) && --dragN <= 0) { dragN = 0; cmp.classList.remove('drop') } })
  chat.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return
    e.preventDefault(); e.stopPropagation()
    dragN = 0; cmp.classList.remove('drop')
    addFiles(e.dataTransfer.files)
  })
  fileIn.addEventListener('change', function () { addFiles(fileIn.files); fileIn.value = '' })

  // ---------- Gửi ----------
  function send() {
    var note = ta.value.trim()
    if (attPending) { msg.textContent = L('Đang xử lý ảnh, đợi một chút rồi bấm Gửi lại.', 'Still processing an image; wait a moment, then press Send again.'); return }
    if (!note && !atts.length && !picks.some(function (p) { return p.note.trim() })) { msg.textContent = L('Hãy gõ ghi chú hoặc dán ảnh trước.', 'Type a note or paste an image first.'); return }
    // Token [X] không khớp phần tử nào đã chọn: cảnh báo một lần, bấm Gửi lần nữa (tin không đổi) thì vẫn gửi.
    var refs = picks.map(function (p) { return p.ref }), bad = []
    note.replace(/\[([A-Z])\]/g, function (_, r) { if (refs.indexOf(r) < 0 && bad.indexOf(r) < 0) bad.push(r) })
    if (bad.length && warnedNote !== note) {
      warnedNote = note
      var toks = '[' + bad.join('], [') + ']'
      msg.textContent = L(toks + ' không khớp phần tử nào đã chọn. Bấm Gửi lần nữa để vẫn gửi.', toks + ' matches no picked element. Press Send again to send anyway.')
      return
    }
    warnedNote = null
    var body = { note: note, lang: LANG, url: location.href, metroOrigin: location.origin, viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } }
    if (picks.length) {
      body.elements = picks.map(function (p) {
        return { ref: p.ref, note: p.note.trim() || null, element: p.data.element, components: p.data.components, stacks: p.data.stacks, debugSources: p.data.debugSources }
      })
      // Một phần tử: gửi thêm dạng cũ để bridge bản cũ còn chạy nền (đọc overlay mới từ đĩa) vẫn nhận được phần tử.
      // Bridge mới ưu tiên elements[] và bỏ qua các trường này.
      if (picks.length === 1) { body.element = picks[0].data.element; body.components = picks[0].data.components; body.stacks = picks[0].data.stacks; body.debugSources = picks[0].data.debugSources }
    }
    if (atts.length) body.images = atts.map(function (a) { return { data: a.data, mime: a.mime, w: a.w, h: a.h } })
    msg.textContent = L('Đang gửi…', 'Sending…')
    connect().then(function () {
      // Bridge cũ còn chạy nền (chưa biết ảnh): ảnh lớn bị 413, ảnh nhỏ bị bỏ không báo. Giữ nguyên tin để gửi lại sau khi thay bridge.
      if (body.images && !bridgeImages) throw new Error(L('bridge đang chạy là bản cũ, chưa nhận ảnh: chạy `tl-ui-feedback stop` rồi tải lại trang.', 'the running bridge is outdated and does not take images: run `tl-ui-feedback stop`, then reload the page.'))
      return api('/api/feedback', { method: 'POST', body: JSON.stringify(body) })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) }).then(function (x) {
      if (!x.ok) throw new Error(x.j.error || L('lỗi', 'error'))
      ta.value = ''; clearPicks(); clearAtts(); msg.textContent = ''
      return loadHistory().then(function () { render(true) }) // đồng bộ chắc chắn kể cả khi SSE chưa kịp tới; render(true) cuộn xuống cuối để thấy tin vừa gửi
    }).catch(function (e) { msg.textContent = L('Lỗi: ', 'Error: ') + e.message })
  }
  chat.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-a]') : null
    var a = t && t.getAttribute('data-a')
    if (a === 'send') send()
    else if (a === 'pick') togglePick()
    else if (a === 'multi') setMulti(!multiOn)
    else if (a === 'attach') fileIn.click()
    else if (a === 'unatt') { removeAtt(+t.getAttribute('data-i')); ta.focus() }
    else if (a === 'atok') insertRef('img' + (+t.getAttribute('data-i') + 1))
    else if (a === 'resend') resend(t)
    else if (a === 'unpick') { unpick(t.getAttribute('data-ref')); ta.focus() }
    else if (a === 'ref') insertRef(t.getAttribute('data-ref'))
    else if (a === 'close') setOpen(false)
    else if (a === 'clear') clearHistory()
    else if (a === 'pin') { pinned = !pinned; savePin(); applyPin() }
    else if (a === 'connect') copyConnect()
    else if (a === 'measure') { measureOn = !measureOn; try { localStorage.setItem(MEASURE_KEY, measureOn ? '1' : '0') } catch (_) {} applyMeasure() }
    else if (a === 'unstale') { staleDismissed = t.getAttribute('data-id'); render() }
    else if (a === 'nudge') copyPrompt(t, nudgePrompt(t.getAttribute('data-id')), L('Đã chép lời nhắc: dán vào terminal của agent.', 'Reminder copied: paste it into the agent\'s terminal.'))
  })
  // Gửi lại tin cũ: bridge nhân bản item (kèm phần tử đã chọn); nếu bridge không còn item đó (404) thì gửi lại riêng nội dung chữ.
  function resend(btn) {
    var id = btn.getAttribute('data-id'), text = btn._text
    btn.disabled = true
    msg.textContent = L('Đang gửi lại…', 'Resending…')
    function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body) }) }
    connect().then(function () {
      return id ? post('/api/feedback/resend', { id: id }) : { ok: false, status: 404 }
    }).then(function (r) {
      if (r.ok || r.status !== 404) return r
      return post('/api/feedback', { note: text, lang: LANG, url: location.href, metroOrigin: location.origin, viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status)
      msg.textContent = ''
      return loadHistory().then(function () { render(true) })
    }).catch(function (e) { msg.textContent = L('Không gửi lại được: ', 'Could not resend: ') + e.message })
      .then(function () { btn.disabled = false })
  }
  function clearHistory() {
    if (!entries.length) return
    if (!window.confirm(L('Xóa toàn bộ lịch sử hội thoại của site này?', 'Clear the whole conversation history for this site?'))) return
    connect().then(function () {
      return api('/api/history/clear?origin=' + encodeURIComponent(location.origin), { method: 'POST' })
    }).then(function (r) { if (!r.ok) throw new Error(r.status); entries = []; render() })
      .catch(function (e) { msg.textContent = L('Không xóa được: ', 'Could not clear: ') + e.message })
  }

  // Nút Feedback đi theo khung chat khi khung đã kéo/đổi cỡ: canh mép phải, nằm ngay dưới khung (hết chỗ thì nằm ngay trên).
  function syncFab() {
    if (pinned) { // ghim: khung đang mở thì ẩn nút (đóng khung bằng ×), đang đóng thì nút về góc mặc định để mở lại
      fab.style.left = 'auto'; fab.style.top = 'auto'; fab.style.right = '14px'; fab.style.bottom = '14px'
      return
    }
    if (!chat.style.left || chat.style.left === 'auto' || chat.style.display === 'none' || !chat.offsetWidth) return
    var r = chat.getBoundingClientRect(), fw = fab.offsetWidth, fh = fab.offsetHeight
    var x = Math.min(Math.max(0, r.right - fw), Math.max(0, window.innerWidth - fw))
    var y = r.bottom + 8 + fh <= window.innerHeight ? r.bottom + 8 : Math.max(0, r.top - 8 - fh)
    fab.style.left = x + 'px'; fab.style.top = y + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto'
  }

  // ---------- Kéo di chuyển khung chat (nắm thanh tiêu đề) ----------
  var hd = $('.hd'), dragOff = null
  hd.style.cursor = 'move'
  hd.addEventListener('pointerdown', function (e) {
    if (pinned || e.button !== 0 || (e.target.closest && e.target.closest('button, label'))) return
    var r = chat.getBoundingClientRect()
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top }
    chat.style.left = r.left + 'px'; chat.style.top = r.top + 'px'
    chat.style.right = 'auto'; chat.style.bottom = 'auto'
    try { hd.setPointerCapture(e.pointerId) } catch (_) {}
    e.preventDefault()
  })
  hd.addEventListener('pointermove', function (e) {
    if (!dragOff) return
    var w = chat.offsetWidth, h = chat.offsetHeight
    var x = Math.min(Math.max(0, e.clientX - dragOff.x), Math.max(0, window.innerWidth - w))
    var y = Math.min(Math.max(0, e.clientY - dragOff.y), Math.max(0, window.innerHeight - h))
    chat.style.left = x + 'px'; chat.style.top = y + 'px'
    syncFab()
  })
  function endDrag(e) { if (dragOff) { dragOff = null; try { hd.releasePointerCapture(e.pointerId) } catch (_) {} } }
  hd.addEventListener('pointerup', endDrag)
  hd.addEventListener('pointercancel', endDrag)

  // ---------- Kéo góc trên-trái để đổi kích thước (cạnh phải/dưới đứng yên) ----------
  var rz = $('.rz'), rzFrom = null
  rz.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    var r = chat.getBoundingClientRect()
    rzFrom = { right: r.right, bottom: r.bottom }
    chat.style.left = r.left + 'px'; chat.style.top = r.top + 'px'
    chat.style.width = r.width + 'px'; chat.style.height = r.height + 'px'
    chat.style.right = 'auto'; chat.style.bottom = 'auto'; chat.style.maxWidth = 'none'
    try { rz.setPointerCapture(e.pointerId) } catch (_) {}
    e.preventDefault()
  })
  rz.addEventListener('pointermove', function (e) {
    if (!rzFrom) return
    var w = Math.min(Math.max(300, rzFrom.right - Math.max(0, e.clientX)), Math.min(window.innerWidth, 900))
    var h = Math.min(Math.max(240, rzFrom.bottom - Math.max(0, e.clientY)), window.innerHeight)
    chat.style.width = w + 'px'; chat.style.height = h + 'px'
    chat.style.left = Math.max(0, rzFrom.right - w) + 'px'; chat.style.top = Math.max(0, rzFrom.bottom - h) + 'px'
    syncFab()
  })
  function endRz(e) { if (rzFrom) { rzFrom = null; try { rz.releasePointerCapture(e.pointerId) } catch (_) {} } }
  rz.addEventListener('pointerup', endRz)
  rz.addEventListener('pointercancel', endRz)
  // ---------- Tự tải lại khi file tĩnh đổi (chỉ có khi trang đi qua serve thư mục/file) ----------
  var liveBox = $('[data-live]'), LIVE_KEY = 'uifb.live', liveV = null, liveT = null
  function liveCheck() {
    fetch('/__uifb/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || !liveBox.checked) return
      if (liveV === null) liveV = j.v
      else if (j.v !== liveV) { if (ta.value.trim() || picks.length) return; location.reload() } // đang gõ dở ghi chú / có phần tử chờ gửi thì chờ, đừng làm mất
    }).catch(function () {})
  }
  function liveApply() {
    liveBox.parentNode.classList.toggle('on', liveBox.checked)
    clearInterval(liveT); liveT = null; liveV = null
    if (liveBox.checked) { liveCheck(); liveT = setInterval(liveCheck, 1000) }
  }
  liveBox.addEventListener('change', function () { try { localStorage.setItem(LIVE_KEY, liveBox.checked ? '1' : '0') } catch (_) {} liveApply() })
  fetch('/__uifb/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
    if (!j || typeof j.v !== 'string') return
    liveBox.parentNode.hidden = false
    try { liveBox.checked = localStorage.getItem(LIVE_KEY) === '1' } catch (_) {}
    liveApply()
  }).catch(function () {})
  applyMeasure()
  // ---------- Ghim bên phải + kéo mép trái đổi chiều rộng ----------
  var pinBtn = $('[data-a="pin"]'), rzw = $('.rzw'), PIN_KEY = 'uifb.pin'
  function maxPinW() { return Math.max(280, Math.min(900, Math.floor(window.innerWidth * 0.8))) }
  function savePin() { try { localStorage.setItem(PIN_KEY, JSON.stringify({ pinned: pinned, w: pinWant })) } catch (_) {} }
  function loadPin() {
    try {
      var j = JSON.parse(localStorage.getItem(PIN_KEY) || 'null')
      if (j) { pinned = !!j.pinned; if (+j.w) pinWant = +j.w }
    } catch (_) {}
  }
  // Phần tử position:fixed dính mép phải (panel ghim riêng của site, header/thanh toàn chiều rộng) không co theo width của <html>
  // nên vẫn nằm dưới khung chat: dịch mép phải của chúng sang trái đúng bằng chiều rộng khung, sau đó khôi phục nguyên trạng khi bỏ ghim.
  // position:absolute không có tổ tiên nào được định vị (popover kiểu `#pop{position:absolute;right:12px}` ngay trong body) cũng vậy:
  // nó neo theo viewport, không theo <html>, nên xử lý giống fixed. Chỉ xét `position` của tổ tiên, CỐ Ý bỏ qua transform/filter/contain:
  // lượt quét chạy SAU khi <html> co, nên phần tử neo theo cha co theo trang không còn chạm mép phải và tự bị loại; còn chạm mép tức là
  // cha không co (vd translate + 100vw), dịch nó là đúng. Phải chặn tổ tiên được định vị vì chúng (fixed/absolute) có thể cũng bị dịch → dịch hai lần.
  function viewportAnchored(el, cs, memo) {
    if (cs.position === 'fixed') return true
    if (cs.position !== 'absolute') return false
    var chain = [], p = el.parentElement, ok = true
    while (p) {
      if (memo.has(p)) { ok = memo.get(p); break }
      chain.push(p)
      if (getComputedStyle(p).position !== 'static') { ok = false; break }
      p = p.parentElement
    }
    // memo[p] = "con absolute của p không có tổ tiên định vị": đúng cho mọi nút đã đi qua (kể cả nút chặn, khi kết luận là sai).
    chain.forEach(function (a) { memo.set(a, ok) })
    return ok
  }
  var shifted = new Map(), shiftRaf = 0, shiftTimer = 0, shiftMo = null, lastScanMs = 0
  function unshiftFixed() {
    shifted.forEach(function (o, el) {
      Object.keys(o).forEach(function (k) {
        if (el.style.getPropertyValue(k) !== o[k][2]) return // site đã tự đổi giá trị này sau khi mình dịch: không ghi đè
        if (o[k][0]) el.style.setProperty(k, o[k][0], o[k][1]); else el.style.removeProperty(k)
      })
    })
    shifted.clear()
  }
  function shiftFixed() {
    shiftRaf = 0
    unshiftFixed()
    if (!(pinned && open && !hidden) || !document.body) return
    var t0 = performance.now()
    var vw = document.documentElement.clientWidth || window.innerWidth, edge = chat.getBoundingClientRect().left, els = document.body.getElementsByTagName('*') // edge: mép trái khung ghim (đã trừ thanh cuộn)
    var todo = [], memo = new Map()
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el === host || host.contains(el)) continue
      var cs = getComputedStyle(el)
      if (!viewportAnchored(el, cs, memo)) continue
      var r = el.getBoundingClientRect()
      if (!r.width || !r.height || r.right < vw - 24) continue // không chạm mép phải
      todo.push([el, cs.right, r.width])
    }
    todo.forEach(function (t) {
      var el = t[0], o = {}, set = function (k, v) {
        o[k] = [el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]
        el.style.setProperty(k, v, 'important')
        o[k].push(el.style.getPropertyValue(k)) // giá trị mình vừa đặt, để nhận ra site có đổi sau đó không
      }
      var right = parseFloat(t[1])
      if (t[1] !== 'auto' && isFinite(right)) set('right', right + pinW + 'px')
      // width cố định (vd 100vw) làm right bị bỏ qua: nếu mép phải chưa dịch thì co luôn width.
      if (t[1] === 'auto' || !isFinite(right) || el.getBoundingClientRect().right > edge + 1) set('width', Math.max(0, edge - el.getBoundingClientRect().left) + 'px')
      shifted.set(el, o)
    })
    if (shiftMo) shiftMo.takeRecords() // bỏ qua các thay đổi do chính mình vừa ghi
    lastScanMs = performance.now() - t0
  }
  function scheduleShift(delay) {
    if (!(pinned && open && !hidden)) {
      clearTimeout(shiftTimer); shiftTimer = 0; if (shiftRaf) cancelAnimationFrame(shiftRaf); shiftRaf = 0
      if (shiftMo) { shiftMo.disconnect(); shiftMo = null }
      unshiftFixed()
      return
    }
    if (!shiftMo && window.MutationObserver) {
      // Site mở/đóng panel của nó sau khi ghim: quét lại (gộp theo thời gian để không quét liên tục).
      shiftMo = new MutationObserver(function (ms) {
        if (ms.every(function (m) { return host.contains(m.target) })) return
        scheduleShift(Math.max(250, Math.round(lastScanMs * 40))) // quét càng tốn thì càng thưa: tối đa khoảng 2,5% thời gian của luồng chính
      })
      shiftMo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] }) // style: popover mở bằng el.style.display (React…)
    }
    // Throttle, không debounce: trang có animation đổi style liên tục vẫn được quét lại định kỳ thay vì bị hoãn mãi.
    if (delay) { if (!shiftTimer) shiftTimer = setTimeout(function () { shiftTimer = 0; if (!shiftRaf) shiftRaf = requestAnimationFrame(shiftFixed) }, delay) }
    else if (!shiftRaf) shiftRaf = requestAnimationFrame(shiftFixed)
  }
  function applyPin(dragging) {
    pinW = Math.min(Math.max(280, pinWant), maxPinW())
    chat.classList.toggle('pin', pinned)
    chat.style.setProperty('--pw', pinW + 'px')
    pinBtn.classList.toggle('on', pinned)
    fab.style.display = pinned && open ? 'none' : ''
    pinBtn.title = pinned ? L('Bỏ ghim (trả khung về vị trí tự do)', 'Unpin (free-floating panel)') : L('Ghim cố định bên phải trang (kéo mép trái để đổi chiều rộng)', 'Pin to the right edge (drag the left edge to resize)')
    pinBtn.setAttribute('aria-label', pinned ? L('Bỏ ghim', 'Unpin') : L('Ghim', 'Pin'))
    hd.style.cursor = pinned ? 'default' : 'move'
    var de = document.documentElement
    if (pinned && open && !hidden) {
      // Trang co lại bằng width của <html>: margin-right bị bỏ qua khi site đặt html{width:100%} (ràng buộc thừa).
      if (htmlW0 === null) htmlW0 = [de.style.getPropertyValue('width'), de.style.getPropertyPriority('width')]
      de.style.setProperty('width', 'calc(100% - ' + pinW + 'px)', 'important')
    } else if (htmlW0 !== null) {
      if (htmlW0[0]) de.style.setProperty('width', htmlW0[0], htmlW0[1])
      else de.style.removeProperty('width')
      htmlW0 = null
    }
    syncFab()
    scheduleShift(dragging ? 120 : 0) // đang kéo: quét gộp theo thời gian, không quét mỗi khung hình
  }
  var rzwOn = false
  rzw.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    rzwOn = true; rzw.classList.add('on')
    try { rzw.setPointerCapture(e.pointerId) } catch (_) {}
    e.preventDefault()
  })
  rzw.addEventListener('pointermove', function (e) {
    if (!rzwOn) return
    pinWant = Math.min(Math.max(280, window.innerWidth - e.clientX), 900)
    applyPin(true)
  })
  function endRzw(e) { if (rzwOn) { rzwOn = false; rzw.classList.remove('on'); try { rzw.releasePointerCapture(e.pointerId) } catch (_) {} savePin(); applyPin() } }
  rzw.addEventListener('pointerup', endRzw)
  rzw.addEventListener('pointercancel', endRzw)
  window.addEventListener('resize', function () { if (pinned) applyPin() })
  loadPin()
  applyPin()

  // Khung đã kéo/đổi cỡ có left/top cố định: kẹp lại khi cửa sổ thu nhỏ hoặc xoay màn hình để thanh tiêu đề luôn kéo được.
  function clampChat() {
    if (!chat.style.left || chat.style.left === 'auto') return
    var w = Math.min(chat.offsetWidth, window.innerWidth), h = Math.min(chat.offsetHeight, window.innerHeight)
    if (chat.style.width && chat.offsetWidth > window.innerWidth) chat.style.width = w + 'px'
    if (chat.style.height && chat.offsetHeight > window.innerHeight) chat.style.height = h + 'px'
    chat.style.left = Math.min(Math.max(0, parseFloat(chat.style.left) || 0), Math.max(0, window.innerWidth - w)) + 'px'
    chat.style.top = Math.min(Math.max(0, parseFloat(chat.style.top) || 0), Math.max(0, window.innerHeight - h)) + 'px'
    syncFab()
  }
  window.addEventListener('resize', clampChat)
  // Alt+Shift+K: bật/tắt chế độ chọn (dùng e.code vì trên macOS Alt+K đổi e.key thành ký tự khác). Cũng chạy khi đang gõ trong khung chat.
  function isPickKey(e) {
    return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyK' || e.key === 'K' || e.key === 'k')
  }
  // onKeyDown (capture ở document) nhận phím từ textarea trước (sự kiện bàn phím là composed) và đánh dấu e._uifb;
  // ở đây chỉ xử lý khi nó chưa chạy (site chặn sự kiện ở window), nếu không Alt+Shift+K bị bật/tắt hai lần.
  // Gắn ở cả vùng soạn tin: ô tin nhắn chung và các ô ghi chú riêng của từng phần tử (Ctrl+Enter gửi ở ô nào cũng được).
  ;['keydown', 'keyup', 'keypress'].forEach(function (t) {
    cmp.addEventListener(t, function (e) {
      e.stopPropagation()
      var rk = t === 'keydown' && (e.target === ta || e.target.type === 'text') ? refKey(e) : null
      if (t === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
      else if (rk) { e.preventDefault(); insertRef(rk, e.target) }
      else if (t !== 'keydown' || e._uifb) return
      else if (e.key === 'Escape' && picking) stopPicking()
      else if (isPickKey(e)) { e.preventDefault(); togglePick() }
    })
  })

  // Tương tác với khung chat không được lọt ra trang: modal/popup của site coi click hoặc focus ngoài nó là "bấm ra ngoài" và tự đóng.
  ;['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress'].forEach(function (t) {
    host.addEventListener(t, function (e) { e.stopPropagation() })
  })

  // Bẫy focus của modal (vd react-native-web: document.addEventListener('focus', trap, true)) giật focus khỏi khung chat về ô của modal,
  // nên gõ ghi chú lại chui vào ô của site. Chặn sự kiện focus của khung chat ngay ở window (pha capture chạy trước document).
  ;['focus', 'focusin', 'blur', 'focusout'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      if (e.composedPath && e.composedPath().indexOf(host) >= 0) e.stopPropagation()
    }, true)
  })

  // ---------- Sự kiện toàn cục ----------
  var hooked = [] // document đã gắn listener: trang chính + iframe cùng origin
  var watched = typeof WeakSet === 'function' ? new WeakSet() : null
  function setCursor(c) {
    pruneHooked()
    hooked.forEach(function (d) { try { d.documentElement.style.cursor = c } catch (_) {} })
    hooked.forEach(function (d) { setDisabledPass(d, !!c) })
  }
  // Control đang disabled (và con của nó) không nhận chuột/click nên overlay không bắt được. Khi đang chọn, tạm đặt pointer-events:none để
  // sự kiện rơi xuống tổ tiên; elementAt/underNoneEvents sẽ tìm lại đúng phần tử disabled theo toạ độ.
  function setDisabledPass(d, on) {
    try {
      var s = d.getElementById('ui-feedback-disabled-pass')
      if (!on) { if (s) s.remove(); return }
      if (s) return
      s = d.createElement('style'); s.id = 'ui-feedback-disabled-pass'
      s.textContent = ':disabled,:disabled *{pointer-events:none!important}'
      ;(d.head || d.documentElement).appendChild(s)
    } catch (_) {}
  }
  var observers = [] // [doc, MutationObserver]: ngắt khi document của iframe đã bị hủy
  function pruneHooked() {
    hooked = hooked.filter(function (d) { return d.defaultView })
    observers = observers.filter(function (o) { if (o[0].defaultView) return true; o[1].disconnect(); return false })
  }
  function hasIframe(records) {
    return records.some(function (m) {
      return Array.prototype.some.call(m.addedNodes, function (n) { return n.nodeType === 1 && (n.tagName === 'IFRAME' || n.querySelector('iframe')) })
    })
  }
  function hookDoc(doc) {
    pruneHooked()
    if (hooked.indexOf(doc) >= 0) return
    hooked.push(doc)
    if (picking && doc !== document) { doc.documentElement.style.cursor = 'crosshair'; setDisabledPass(doc, true) }
    doc.addEventListener('mousemove', onMove, true)
    ;['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) { doc.addEventListener(t, swallow, true) })
    doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
    doc.addEventListener('touchend', onTouchEnd, { capture: true, passive: false })
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('keydown', onKeyDown, true)
    doc.addEventListener('scroll', scheduleMarks, true) // cuộn trang/iframe/vùng cuộn con: huy hiệu đi theo phần tử
    // iframe điều hướng thì document đổi: nghe 'load' để gắn lại; iframe thêm sau thì MutationObserver bắt
    if (typeof MutationObserver === 'function') {
      var mo = new MutationObserver(function (records) { if (hasIframe(records)) hookFrames(doc) }) // chỉ quét khi có iframe mới được thêm
      mo.observe(doc.documentElement, { childList: true, subtree: true })
      observers.push([doc, mo])
    }
    hookFrames(doc)
  }
  function hookFrames(doc) {
    var fs = doc.querySelectorAll('iframe')
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i]
      if (!watched || !watched.has(f)) {
        if (watched) watched.add(f)
        f.addEventListener('load', function () { hookFrames(doc) })
      }
      var cd = frameDoc(f)
      if (cd && cd.documentElement) hookDoc(cd)
    }
  }
  function onKeyDown(e) {
    e._uifb = true
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyH' || e.key === 'h' || e.key === 'H')) { e.preventDefault(); toggleHidden() }
    else if (hidden) return
    else if (isPickKey(e)) { e.preventDefault(); togglePick() }
    else if (e.key === 'Escape' && picking) stopPicking()
  }
  hookDoc(document)
  fab.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!open) })

  // Tự kết nối ngay khi nạp (không đợi mở khung chat): có vậy trang mới nghe được thẻ xin quyền (SSE) và hiện trạng thái agent.
  // Bridge chưa chạy thì thử lại thưa dần (5s → tối đa 60s) để không làm ồn console của site.
  var autoDelay = 5000
  function autoConnect() {
    connect().catch(function () {
      setTimeout(autoConnect, autoDelay)
      autoDelay = Math.min(autoDelay * 2, 60000)
    })
  }
  // Tab quay lại tiền cảnh (có thể đã bị trình duyệt treo luồng SSE khi ở nền): đồng bộ lại thẻ xin quyền và lịch sử.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && token) loadHistory() })
  autoConnect()
})()
