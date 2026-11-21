---
name: tl-ui-feedback
description: Receive UI feedback straight from the user's browser (they click a wrong element and type a note) and fix the code accordingly. Use when the user says "let me point at the UI in the browser", "I'll pick the wrong element", "wait for UI feedback", "tl-ui-feedback", "open the site so I can point at the UI", "tl-ui-feedback serve", or is iterating on a UI and wants to avoid sending screenshots.
---

# UI Feedback

The user opens a dev page through `tl-ui-feedback serve` (or the dev-only line), clicks the wrong element and types a note. You receive the note, selector, styles, component chain and **source file:line**.

## Quick call: `/tl-ui-feedback ...`
Do every step below yourself; ask back only if information is missing.

Arguments are a **site** (dev server port, URL, or HTML folder/file) and an optional **overlay port** (the page with the Feedback button). They are DIFFERENT ports: the user opens the overlay port; the dev server port itself has no Feedback button.

| User types | Command you run |
|---|---|
| `/tl-ui-feedback <site>` (bare `N` = `http://localhost:N`) | `tl-ui-feedback serve <site>` (overlay port auto-picked) |
| `/tl-ui-feedback <site> <port>`, `<port> <site>`, or two numbers `<N1> <N2>` | `tl-ui-feedback serve <arg1> <arg2>` as typed. With two numbers the CLI finds the dev server (the port that answers) and prints which it chose; if it cannot tell, it prints an error: ask the user. |
| `/tl-ui-feedback serve --cmd "<dev command>" <port>` (site not running yet) | `tl-ui-feedback serve --cmd "<dev command>" http://localhost:<port>` |
| `/tl-ui-feedback serve ...` (other forms) | pass through verbatim |
| `/tl-ui-feedback` (no arguments) | `tl-ui-feedback serve --list`; reuse your own serve, otherwise ask for the site |
| A prompt saying the page `<origin>` is already open (copied from the page's "Connect agent" button) | nothing: skip steps 1–4, set `ORIGIN = <origin>`, start the loop; on stop, do not stop any serve |

Steps:
1. Run `tl-ui-feedback serve --list`. Reuse a serve only if THIS session started it, then skip step 2. Never touch or stop another session's serve: each agent is bound to one site.
2. Run the `serve` command **in the background** (`run_in_background`); it runs until stopped. Do not add `--no-open`. With `--cmd`, add `--wait 180` for a slow app (default 60 s).
3. Read its output until the line with `http://localhost:<p>` (`serving … at …` / `đang phục vụ … tại …`). A line starting with `error:` / `lỗi:` (port busy, command exited, timeout, upstream not loopback): report it and stop; do not try another command or port.
4. Tell the user one line: the address `http://localhost:<p>` (overlay port) and "click Feedback, click an element, type a note". With two numbers, repeat which port the CLI took as the dev server. (If they ran `tl-ui-feedback install-hooks`, your permission prompts appear as Allow/Deny cards in the page while you stay in the loop, also after a reply, as long as the page is open; risky commands still ask in the terminal.)
5. Set `ORIGIN = http://localhost:<p>` and start the loop. Pass `origin: ORIGIN` to every poll and reply. When the user says stop, run `tl-ui-feedback serve --stop <p>` (also stops a `--cmd` dev server).

If `tl-ui-feedback` is not on PATH, use `~/.ui-feedback/bin/tl-ui-feedback` (Windows: `%USERPROFILE%/.ui-feedback/bin/tl-ui-feedback.cmd`).
A page through `serve` has the serve port as its origin, so login/localStorage are separate from the original port. Use only for the user's own site.

## Loop
Tools: `tl_ui_feedback_poll`, `tl_ui_feedback_reply` (with a prefix such as `mcp__plugin_tl-ui-feedback_tl-ui-feedback__` or `mcp__tl-ui-feedback__`; pick the one ending in that name). No MCP tool: use CLI `tl-ui-feedback poll --origin ORIGIN` (in the background) / `reply`.

1. Poll with `origin: ORIGIN` (without it you take other sites' messages; while a serve runs it is an error). Poll acks receipt, so the page shows the agent has read it; with no reply in 15 minutes the page marks it unanswered (any progress reply resets that; late replies still count). On timeout poll again; nothing is lost. If poll returns `status: unanswered`, you took those items earlier but never sent the final reply: send it now (with `id`), then poll again.
2. Open the files in `source`: the first line builds the element, the next is where the parent uses it, usually the place to fix. No source file: use `components`, `selector`, `text`. A selector like `#f >>> #in >>> #deep` is inside nested same-origin iframes (`>>>` separates levels; not valid for `querySelector`).
3. Make the minimal change for exactly what the note asks.
4. Replies show live in the page. Write every reply in the language of the user's note (a Vietnamese note gets a Vietnamese reply); if the note is too short to tell, use `page_lang` (the overlay's UI language). Right after receiving, reply with `origin` and no `id`: one short sentence ("looking at desktop.tsx" / "đang xem desktop.tsx"); send more progress replies if work takes long. Final reply: with `id`, one point per line. A question ("what does this mean?") also gets its answer through reply with `id`: what you write in the terminal never reaches the page. CLI multi-line text must go through stdin (`printf 'a\nb' | tl-ui-feedback reply - --id <id>`; PowerShell `"a`nb" | ...`), because the Windows .cmd shim cuts arguments at newlines.
5. Poll again. Stop only when the user says stop.

## Notes
- A free message has no element/source: follow the note.
- Source files need a React dev server with Metro symbolicate (Expo); production builds have none.
- Elements from a loop point to the `map` line; use `text`/`testID` to find the item.
- Do not send note content or page text off the machine.
- If the page says the running bridge is outdated, run `tl-ui-feedback stop` and ask the user to reload the page (normally the CLI/MCP replaces an older bridge on its own).
