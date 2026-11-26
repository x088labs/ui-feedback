# UI Feedback

Point at the wrong part of your UI in the browser, and your coding agent receives your note plus the selector, styles, component chain and source `file:line`. It fixes the code and replies in the page. No screenshots needed, though you can paste one when it helps.

```
Browser overlay ──POST──▶ bridge 127.0.0.1:47831 ◀── poll / MCP ── agent (Claude Code, Codex)
       ▲                        │
       └──── SSE: agent reply ◀─┘
```

Node >= 22, no dependencies. The overlay and CLI speak English, or Vietnamese when your browser / locale is Vietnamese (`UIFB_LANG=en|vi` for the CLI). The agent replies in the chat box in the language of your note, falling back to the overlay's UI language (sent with each note as `page_lang`) when the note is too short to tell.

## Install

```bash
node bridge/cli.mjs install          # skill + MCP server + `tl-ui-feedback` command
node bridge/cli.mjs install --path   # also add the command to your PATH (Windows)
```

Check with `claude mcp list`.

As a Claude Code plugin instead (no clone needed), in a terminal:

```bash
claude plugin install tl-ui-feedback --marketplace x088labs/ui-feedback
```

or inside Claude Code, one command at a time: `/plugin marketplace add x088labs/ui-feedback`, then `/plugin install tl-ui-feedback@ui-feedback`. Start a new session afterwards.

To try a local clone: `claude --plugin-dir <this-folder>`. Use the plugin or `install`, not both.

## Use

1. In Claude Code, type `/tl-ui-feedback <site>` (a port, URL or folder), or tell the agent to wait for UI feedback. The agent starts `serve`, gives you the address and waits.
2. Or serve the site yourself and open the printed address:
   ```bash
   tl-ui-feedback serve http://localhost:8081      # proxy a running dev server
   tl-ui-feedback serve ./dist --spa               # serve static files (with an Auto-reload toggle)
   tl-ui-feedback serve --cmd "npm run dev" http://localhost:5173   # start the dev server too
   tl-ui-feedback serve 8081 8082                  # two ports: the one with a server is the dev server
   ```
3. Click **Feedback**, pick an element, type a note, **Send to agent** (Ctrl+Enter). A plain click replaces the picked element; hold **Ctrl** (Cmd on macOS) while clicking, or turn on the **+** button on touch devices, to add more elements to the same message, labelled A, B, C… (up to 10) with a badge on the page (touch screens pick one element); every element has its own optional note (click its badge to edit it, × to remove it; other labels stay the same). Mention elements in your message with `[A]`, `[B]`, typed, inserted by clicking the label, or inserted with **Alt+A**, **Alt+B**… while typing in the message or a note, e.g. "why does clicking [A] not reload [B]?". Paste images (Ctrl+V) into the message or a note, drop them on the panel, or use the image button next to **+**: up to 4 per message, downscaled in the browser (longest side 1600px, WebP/JPEG, at most 1.5 MB each); click an `img1` label to insert `[img1]` into the note. A message can be images only. Agents on MCP get the images as image blocks after the text; agents on the CLI `poll` get paths to files in a temp folder (`UIFB_IMG_DIR`). The agent gets one item with `elements[]` (`ref`, `note`, `element`, `source` each); items with at most one element still carry top-level `element`/`source`. `Esc` or Alt+Shift+K pauses picking; Alt+Shift+H hides the overlay. Elements inside same-origin iframes, `pointer-events:none` layers and disabled controls can be picked too. When no agent is listening to the page, the **Connect agent** button in the chat header copies a prompt with the page's origin; paste it into any agent (Claude Code, Codex…) and it starts polling that page without starting another `serve`. If a message stays at "Agent is working" for 3 minutes with nothing new, the chat explains the likely causes (waiting for approval in the terminal, left the loop, answered in the terminal) and offers **Copy reminder** to paste into the agent (× closes that hint for the message). The Pick element, Send to agent and Connect agent buttons show icons only (with `aria-label` and a tooltip). The ruler button in the chat header shows a DevTools-style box model on the page (margin orange, padding green, content blue) with a label giving width × height, padding, margin and border, for the hovered element while picking and for every picked element; it is off by default and remembered per origin. If the same session polls again without replying, the bridge reminds it automatically (poll returns `status: unanswered`, once per message). Interrupting the agent's poll call now cancels that poll, so it cannot swallow the next message.

Several sites at once: run one `serve` per site. Each agent polls and replies with `origin = http://localhost:<overlay port>`; while a `serve` is running, polling without an origin is an error, so agents never take each other's feedback.

### A deployed site (outside localhost): bookmarklet

To point at UI on a staging/QA deployment such as `https://qa.example.com` without a proxy. The page keeps its real origin, so cookies, sign-in (SSO/OAuth) and API CORS work as usual.

1. `tl-ui-feedback allow https://qa.example.com` (24 hours by default, `--hours N`, `0` = no expiry). It prints a `javascript:…` bookmarklet; save it as a bookmark.
2. Open the site and click the bookmark to show the overlay (click again after each reload). The first time, Chrome asks to let the page access the local network: allow it.
3. The agent listens with `origin = https://qa.example.com` (the page's **Connect agent** button copies that prompt).

`allow --list` shows the list, `allow --remove <site>` removes one. Limits: a CSP that blocks scripts or connections to `127.0.0.1` stops the bookmarklet; production builds have no source `file:line`; permission cards never appear on a site outside localhost; Safari blocks https pages from calling `http://127.0.0.1`.

### Approve the agent's permission prompts in the page (optional)

`tl-ui-feedback install-hooks` adds a `PermissionRequest` hook to Claude Code and Codex. While the agent is handling your UI feedback, its permission prompts appear in the chat as **Allow / Deny** cards. That covers work after the agent has replied or past the 15-minute mark: cards keep coming for 30 minutes after the session's last poll, ack or reply, as long as the site's page is open and the agent process could be identified. Interrupting the agent's poll (Esc, "stop") ends that window at once, so prompts go back to the terminal. The page reloads pending cards when its connection to the bridge comes back or the tab becomes visible again. Risky commands (deleting files, `git push`, publishing, `sudo`, `ssh`, `curl | sh`, writing outside the project or to keys/`.env`, and similar) never get a card and always ask in the terminal. This is a pattern-based safety net, not a sandbox: read each card before you click.

## CLI

`tl-ui-feedback install | uninstall | install-hooks | uninstall-hooks | serve | allow | start | poll | reply "<text>" | status | url | token | stop`

Run `tl-ui-feedback` with no arguments for the full help, `serve --list` to see running servers and `serve --stop <port>` to stop one.

The bridge runs in the background. After an upgrade, the first command that finds an older bridge running stops it and starts the new one (messages still queued in the old bridge are lost).

## Uninstall

Plugin install (one command at a time):

1. `tl-ui-feedback stop` to stop the bridge (the command is available inside a Claude Code session while the plugin is on).
2. `/plugin uninstall tl-ui-feedback@ui-feedback`
3. `/plugin marketplace remove ui-feedback` (optional, removes the marketplace entry too).
4. Start a new session.

If you ran `install-hooks` with the plugin, run `tl-ui-feedback uninstall-hooks` first.

Installed with `node bridge/cli.mjs install`: run `tl-ui-feedback uninstall` (also removes the permission hooks). Optionally delete `~/.ui-feedback/` (token and runtime state).

## Security

- Binds to `127.0.0.1` only; rejects unknown `Host` and non-local `Origin`.
- API calls need a token stored in `~/.ui-feedback/token` (mode 0600), sent as a header. The event stream uses a separate read-only key.
- Any page on localhost can read the token, so do not run untrusted pages on localhost.
- A site allowed with `allow` (https only, expires) must present the pairing key from the bookmarklet, and gets its own token that can only send feedback and read its own conversation: no permission approvals, no other sites' messages. Once you click the bookmarklet, a malicious script on that site could still send fake feedback to the agent, so allow only sites you trust and do not share the bookmarklet. Removing a site or letting it expire cuts its open connection; allowing it again after that issues a new key, so old bookmarklets stop working (allowing a site that has not expired only extends it).
- Source maps are fetched only from the page's own loopback origin; Server Component maps are read only from `.js.map` files inside a `.next` folder.
- Chat history and pasted images stay in memory (images capped at 64 MB in total; images of answered messages are dropped first). The only thing written to disk is pasted images when an agent uses the CLI `poll`, in a temp folder the bridge cleans up. Images are checked by their magic bytes (png, jpeg, webp, gif only). State lives in `~/.ui-feedback/` (`UIFB_HOME`), port via `UIFB_PORT`.

## Limits

- Source `file:line` works on Expo (Metro), Vite and Next dev servers (React 18 and 19, including Next Server Components). Production builds send selector, styles and text only.
- A page through `serve` has the serve port as its origin, so cookies and localStorage are separate from the original port. For a deployed site, use the bookmarklet (`allow`) instead of a proxy.
- No automatic screenshots (pasting images works), Firefox or React Native on device yet.
- Images over MCP need an agent that reads image blocks (Claude Code does); otherwise use the CLI `poll`, which prints file paths.

## Develop

```bash
npm test                  # full suite
npm run test:related      # only tests affected by uncommitted changes (-- --e2e, -- --dry, -- --base main)
```

## Contributing

Issues and pull requests are welcome. Before a pull request can be merged you must sign the Contributor License Agreement, which lets x088labs ship your change as part of ui-feedback; you are asked to sign it on your first pull request.

## License

[PolyForm Internal Use License 1.0.0](LICENSE): source-available, not open source. You and your company may use and change ui-feedback for your internal business operations, including commercial work. You may not distribute it, or changed versions of it, to anyone else, or offer it to others as a product or service.
