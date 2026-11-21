import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nextStep, formatItem } from '../bridge/client.mjs'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'cli.mjs')

test('nextStep: bản CLI hướng dẫn reply - qua stdin, bản MCP dùng tên tool và tham số JSON', () => {
  assert.match(nextStep(1), /reply - --id/)
  assert.match(nextStep(1), /poll --origin/)
  const m = nextStep(1, { mcp: true })
  assert.doesNotMatch(m, /stdin|reply - |--id|tl-ui-feedback /)
  assert.match(m, /`tl_ui_feedback_reply`.*`id`/)
  assert.match(m, /`tl_ui_feedback_poll` again with the same `origin`/)
  assert.match(nextStep(0, { mcp: true }), /tl_ui_feedback_poll/)
  assert.doesNotMatch(nextStep(0, { mcp: true }), /tl-ui-feedback /)
})

test('nextStep + formatItem: nhắc agent trả lời theo ngôn ngữ ghi chú, kèm page_lang', () => {
  for (const s of [nextStep(1), nextStep(1, { mcp: true })]) assert.match(s, /language of the user's note.*page_lang/)
  assert.match(formatItem({ id: 'fb_1', note: 'xoá', lang: 'vi' }), /^page_lang: vi$/m)
  assert.doesNotMatch(formatItem({ id: 'fb_1', note: 'x' }), /page_lang/)
})

test('reply - mà stdin là terminal thì báo lỗi rõ ràng thay vì treo', () => {
  // Không thể giả TTY ở đây; kiểm tra nhánh nội dung rỗng: stdin đóng sẵn => lỗi "rỗng", không treo.
  const r = spawnSync(process.execPath, [CLI, 'reply', '-'], { input: '', encoding: 'utf8', timeout: 10000 })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /rỗng/)
})
