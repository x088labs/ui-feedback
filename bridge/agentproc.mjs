// Nhận diện phiên agent qua tiến trình: hook, `poll` và MCP server đều do CÙNG một tiến trình agent (claude/codex) sinh ra,
// dù cwd của chúng khác nhau (agent cd vào thư mục con). Trả về PID của tổ tiên gần nhất trông giống agent, hoặc 0 nếu không rõ
// (khi đó server rơi về so cwd). Chỉ lấy tổ tiên "giống agent", không lấy terminal/VS Code, vì các phiên khác nhau có thể chung chúng.
import { execFileSync } from 'node:child_process'

const NAME_RE = /^(?:claude|codex)(?:\.exe)?$/i
const CMD_RE = /@anthropic-ai[\\/]claude-code|claude-code[\\/](?:cli|bin)|[\\/]@openai[\\/]codex/i

export const isAgentProc = (name, cmd) => NAME_RE.test(String(name || '')) || CMD_RE.test(String(cmd || ''))

// table: Map pid -> {ppid, name, cmd}. Đi lên từ `pid`, trả PID agent gần nhất (không tính chính pid).
export function findAgentPid(table, pid, maxDepth = 12) {
  const seen = new Set()
  let cur = table.get(pid)?.ppid
  for (let i = 0; i < maxDepth && cur && !seen.has(cur); i++) {
    seen.add(cur)
    const p = table.get(cur)
    if (!p) return 0
    if (isAgentProc(p.name, p.cmd)) return cur
    cur = p.ppid
  }
  return 0
}

function readTable() {
  const t = new Map()
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }'
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const l of out.split(/\r?\n/)) {
      const [pid, ppid, name, ...cmd] = l.split('\t')
      if (+pid) t.set(+pid, { ppid: +ppid, name, cmd: cmd.join('\t') })
    }
  } else {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const l of out.split('\n')) {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
      if (m) t.set(+m[1], { ppid: +m[2], name: m[3].split('/').pop(), cmd: m[4] })
    }
  }
  return t
}

let cached
// PID tiến trình agent đã sinh ra tiến trình hiện tại; 0 nếu không xác định được. Có thể ép bằng UIFB_AGENT_PID (dùng cho test).
export function agentPid() {
  if (process.env.UIFB_AGENT_PID != null) return +process.env.UIFB_AGENT_PID || 0
  if (cached !== undefined) return cached
  try { cached = findAgentPid(readTable(), process.pid) } catch { cached = 0 }
  return cached
}
