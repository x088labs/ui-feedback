# UI Feedback

Point at the wrong part of your UI in the browser and type a note. Your coding agent (Claude Code, Codex…) gets the note plus the element's selector, styles, component chain and source `file:line`, fixes the code and replies in the page. No screenshots needed, though you can paste one.

```
Browser overlay ──POST──▶ bridge 127.0.0.1:47831 ◀── poll / MCP ── agent
       ▲                        │
       └──── SSE: agent reply ◀─┘
```

Needs Node >= 22, no dependencies. The overlay speaks English, or Vietnamese when your browser is Vietnamese. The agent replies in the language of your note.

## Install

As a Claude Code plugin:

```bash
claude plugin install tl-ui-feedback --marketplace x088labs/ui-feedback
```

Or inside Claude Code: `/plugin marketplace add x088labs/ui-feedback`, then `/plugin install tl-ui-feedback@ui-feedback`. Start a new session afterwards.

Or from a clone (skill + MCP server + `tl-ui-feedback` command; `--path` also adds the command to your PATH on Windows):

```bash
node bridge/cli.mjs install
```

Use the plugin or `install`, not both.

## Use

1. In Claude Code, type `/tl-ui-feedback <site>` (a port, URL or folder). The agent starts a local server, gives you the address and waits for feedback.
2. Open that address, click **Feedback**, pick an element, type a note and send it (Ctrl+Enter).
3. The agent fixes the code and replies in the chat.

You can also start the server yourself:

```bash
tl-ui-feedback serve http://localhost:8081      # proxy a running dev server
tl-ui-feedback serve ./dist --spa               # serve static files
tl-ui-feedback serve --cmd "npm run dev" http://localhost:5173   # start the dev server too
```

If no agent is listening, the plug button in the chat header copies a prompt; paste it into any agent to connect it to the page.

### In the chat

- **Several elements:** Ctrl+click (Cmd on macOS), or the **+** button on touch screens, adds elements labelled A, B, C… Mention them in your note as `[A]`, `[B]` (Alt+A, Alt+B… inserts them).
- **Images:** paste (Ctrl+V), drop, or use the image button. Up to 4 per message.
- **Measure:** the ruler button shows a DevTools-style box model (size, padding, margin) for the hovered and picked elements.
- **Status:** the header icon shows the agent's state: a green ear while it listens, a pulsing robot while it works, a hand while it waits for your approval.
- **Shortcuts:** Esc or Alt+Shift+K stops picking, Alt+Shift+H hides the overlay.

Several sites at once: run one `serve` per site; each agent only gets the feedback for its own site.

### Approve permission prompts in the page (optional)

`tl-ui-feedback install-hooks` makes the agent's permission prompts appear in the chat as **Allow / Deny** cards while it works on your feedback. Risky commands (deleting files, `git push`, `sudo`, writing outside the project…) always ask in the terminal. It is a safety net, not a sandbox: read each card before you click.

## CLI

`tl-ui-feedback install | uninstall | install-hooks | uninstall-hooks | serve | poll | reply | status | stop`

Run `tl-ui-feedback` with no arguments for the full help. The bridge runs in the background and is replaced automatically after an upgrade.

## Uninstall

- Plugin: `tl-ui-feedback stop`, then `/plugin uninstall tl-ui-feedback@ui-feedback` (and optionally `/plugin marketplace remove ui-feedback`). If you ran `install-hooks`, run `tl-ui-feedback uninstall-hooks` first.
- Installed from a clone: `tl-ui-feedback uninstall`.

State lives in `~/.ui-feedback/`; delete it if you want a clean slate.

## Security

- The bridge listens on `127.0.0.1` only and rejects unknown hosts and non-local origins.
- API calls need a token from `~/.ui-feedback/token`. Any page on localhost can read it, so do not run untrusted pages on localhost.
- Chat history and images stay in memory. Images are written to a temp folder only when the agent uses the CLI `poll`, and are cleaned up.

## Limits

- Source `file:line` works on Expo (Metro), Vite and Next dev servers (React 18 and 19). Production builds send selector, styles and text only.
- A page opened through `serve` has its own origin, so cookies and localStorage differ from the original port.
- No Firefox or React Native on device yet.

## Develop

```bash
npm test                  # full suite
npm run test:related      # only tests affected by uncommitted changes
```

## Contributing

Issues and pull requests are welcome. Before a pull request can be merged you must sign the Contributor License Agreement, which lets x088labs ship your change as part of ui-feedback; you are asked to sign it on your first pull request.

## License

[PolyForm Internal Use License 1.0.0](LICENSE): source-available, not open source. You and your company may use and change ui-feedback for your internal business operations, including commercial work. You may not distribute it, or changed versions of it, to anyone else, or offer it to others as a product or service.
