#!/usr/bin/env node
// MCP stdio (JSON-RPC, mỗi dòng một message). Hai tool: tl_ui_feedback_poll, tl_ui_feedback_reply.
import readline from 'node:readline'
import fs from 'node:fs'
import { poll, reply, formatItem, nextStep, formatUnanswered } from '../bridge/client.mjs'

// Server chỉ dùng tools/list và tools/call (không đổi qua các bản này), mới nhất đứng đầu.
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const TOOLS = [
  {
    name: 'tl_ui_feedback_poll',
    description:
      'Wait for UI feedback the user points at in the browser (UI Feedback). Returns the note, element, selector, styles and source file:line to fix. After fixing, call tl_ui_feedback_reply, then call this tool again.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'Max wait in seconds (default 900, max 3600)' },
        origin: { type: 'string', description: 'Only take feedback from this origin, e.g. http://localhost:8081. Required while a site runs through serve.' },
        any: { type: 'boolean', description: 'Deliberately take feedback from every site (not recommended)' },
      },
    },
  },
  {
    name: 'tl_ui_feedback_reply',
    description: 'Tell the user (shown in the page) what you changed. Pass the feedback id for a final reply. For a progress message without id, pass origin so it shows only on that site. Write the text in the language of the user\'s note (if the note is too short to tell, use page_lang).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        id: { type: 'string' },
        origin: { type: 'string', description: 'Site origin, e.g. http://localhost:55153 (used when there is no id)' },
      },
      required: ['text'],
    },
  },
]

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

// Tool call đang chạy, theo id JSON-RPC: client hủy (người dùng ngắt agent) thì phải ngắt poll đang chờ.
// Không ngắt thì poll mồ côi vẫn là waiter trong bridge, nhận và ack tin mới, rồi trả kết quả cho một tool call đã bị hủy:
// tin kẹt ở "Agent đã đọc" mà agent không bao giờ thấy.
const inflight = new Map()

async function callTool(name, args = {}, signal) {
  if (name === 'tl_ui_feedback_poll') {
    // Chờ lâu (mặc định 15 phút) để giảm số vòng timeout, mỗi vòng tốn thêm token trong ngữ cảnh của agent.
    const secs = Math.min(Math.max(+args.timeout_seconds || 900, 1), 3600)
    const r = await poll({ origin: args.origin, timeoutMs: secs * 1000, allowAny: !!args.any, signal })
    if (r.status === 'unanswered') return formatUnanswered(r, { mcp: true })
    if (!r.count) return 'timeout: ' + nextStep(0, { mcp: true }) // gọn: không lặp header rỗng
    const body = r.items.map(formatItem).join('\n\n')
    return `status: ${r.status}  count: ${r.count}\n\n${body}\n\nnext_step: ${nextStep(r.count, { mcp: true })}`
  }
  if (name === 'tl_ui_feedback_reply') {
    await reply(String(args.text || ''), args.id, args.origin)
    return 'reply shown in the page'
  }
  throw Object.assign(new Error('unknown tool ' + name), { code: -32602 })
}

const rl = readline.createInterface({ input: process.stdin })
// Client đóng stdin (phiên agent đã thoát): thoát ngay, nếu không poll đang chờ vẫn sống tới hết hạn
// và có thể nhận + ack tin thay cho một agent không còn tồn tại.
rl.on('close', () => process.exit(0))
rl.on('line', async (line) => {
  if (!line.trim()) return
  let m
  try { m = JSON.parse(line) } catch { return err(null, -32700, 'parse error') }
  const { id, method, params } = m
  try {
    if (method === 'initialize') {
      return ok(id, {
        // Theo spec MCP: trả bản client xin nếu server hỗ trợ, nếu không thì bản mới nhất server hỗ trợ.
        protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'ui-feedback', version: VERSION },
      })
    }
    if (method === 'notifications/cancelled') return inflight.get(params?.requestId)?.abort()
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return
    if (method === 'ping') return ok(id, {})
    if (method === 'tools/list') return ok(id, { tools: TOOLS })
    if (method === 'tools/call') {
      const ac = new AbortController()
      inflight.set(id, ac)
      try {
        const text = await callTool(params.name, params.arguments, ac.signal)
        if (!ac.signal.aborted) ok(id, { content: [{ type: 'text', text }] }) // spec MCP: không trả lời request đã bị hủy
        return
      } catch (e) {
        if (ac.signal.aborted) return
        if (e.code === -32602) return err(id, -32602, e.message)
        return ok(id, { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true })
      } finally {
        inflight.delete(id)
      }
    }
    if (id !== undefined) err(id, -32601, 'method not found: ' + method)
  } catch (e) {
    if (id !== undefined) err(id, -32603, e.message)
  }
})
