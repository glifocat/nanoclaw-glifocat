---
name: add-remote-browser
description: Wire the Playwright MCP server (`@playwright/mcp`) into your agent and connect it to a Chrome instance already running on the local network with `--remote-debugging-port`. The agent drives that remote browser via CDP — no Chromium ships in your container, no headless instance is spawned. Use when you have a long-lived browser session on another machine (logged-in tabs, dev profile, etc.) that you want the agent to operate.
---

# Add Remote Browser (Playwright MCP via CDP)

This skill wires `@playwright/mcp` as a stdio MCP server in your agent's container and points it at a Chrome instance running elsewhere on the LAN via the Chrome DevTools Protocol. The agent gets the full `mcp__playwright__*` tool surface (navigate, click, type, screenshot, evaluate, snapshot, etc.) but drives a **real, persistent** browser instead of a fresh container-side headless one.

**When to use this vs `/add-agent-browser`:**
- This skill (`add-remote-browser`) — you have a long-lived browser already running on another machine (your laptop, a desktop on the LAN, a Chromebox in a corner) and you want the agent to drive *that* session. Logged-in tabs survive. The agent doesn't ship Chromium.
- `/add-agent-browser` — you want the agent to spawn a headless browser on demand inside its own container. No remote dependency.

## Prerequisites

### The remote machine must have Chrome listening for CDP

On the machine running Chrome, launch (or restart) Chrome with the remote-debugging flags. The exact path varies by OS:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome"

# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/.config/google-chrome"

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-debugging-address=0.0.0.0
```

Notes:
- `--remote-debugging-address=0.0.0.0` is required for the agent container (which is *not* on the same host as Chrome) to reach the debug port. Default of `127.0.0.1` only accepts local connections.
- Keep using your normal `--user-data-dir` if you want the agent to see your logged-in tabs and extensions. Omit it and you get a fresh profile per launch.
- Chrome **refuses** the remote-debugging port if another Chrome process is already using that profile. Quit Chrome fully first, then relaunch with the flags.

### Security caveat — anyone on the LAN can drive that Chrome

`--remote-debugging-address=0.0.0.0` exposes a fully unauthenticated CDP port. Anyone on the network segment that can reach `<host>:9222` can drive the browser, including extracting cookies. Do not enable this on an untrusted network (public Wi-Fi, conference networks, shared coworking LAN). For trusted home/office LANs, this is usually acceptable; if you want stricter isolation, bind to a specific interface (e.g. a tailscale or wireguard interface IP) instead of `0.0.0.0`.

### Confirm the agent container can reach the debug port

If you have shell on the agent's container, sanity check:

```bash
curl -sS http://<host>:9222/json/version
```

That returns a small JSON blob with `Browser`, `webSocketDebuggerUrl`, etc. — if it does, the wiring will work. If it hangs or 404s, fix the network/firewall before going further.

For a container on the host machine talking to Chrome on the same host: use the Docker host-to-container hostname (`host.docker.internal` on Docker Desktop, `172.17.0.1` on Linux Docker) instead of `127.0.0.1` — the container's loopback isn't the host's.

## Phase 1: Collect connection details

Ask the user:

> 1. What's the IP (or hostname) of the machine running Chrome? Examples: `192.168.1.42`, `desktop.local`, or `host.docker.internal` if Chrome is on the same machine as nanoclaw.
> 2. What port did you launch Chrome's debug listener on? *(default: 9222)*

Hold onto the answers as `HOST` and `PORT` for the rest of the skill.

## Phase 2: Register the MCP server

Call `add_mcp_server` (one of your self-mod MCP tools):

```
add_mcp_server({
  name: "playwright",
  command: "pnpm",
  args: [
    "dlx",
    "@playwright/mcp@latest",
    "--cdp-endpoint",
    "http://<HOST>:<PORT>"
  ]
})
```

This is fire-and-forget — admin approval is requested, and on approve the host updates your container config and restarts your container. You'll be notified when approval is granted or rejected.

Notes:
- `pnpm dlx` is the standard wrapper for one-shot npm MCP servers (matches `/CLAUDE.md`'s module-self-mod guidance). First launch downloads `@playwright/mcp` into pnpm's content-addressable cache; subsequent restarts reuse the cached copy.
- The CDP URL is the Chrome debug-port URL — Chrome serves HTTP at `--remote-debugging-port`, and Playwright resolves the WebSocket endpoint from `<url>/json/version`. Don't pass `ws://...` directly; the `http://` form is the documented input.
- Naming the server `playwright` is the upstream convention — tools surface as `mcp__playwright__navigate`, `mcp__playwright__click`, etc. Pick another name only if you already have a different `playwright` MCP wired in this group.

## Phase 3: Wait for restart

After admin approval, your container is restarted automatically — you do not need to call any restart tool yourself. You'll receive a chat message when the restart completes; resume the conversation from there.

If you want to confirm the wiring landed in your group's config (host-side):

```bash
ncl groups config get
```

Look for `mcpServers.playwright` with the `command`/`args` you submitted.

## Phase 4: Verify

After the container is back up, exercise the connection:

```
mcp__playwright__navigate({ url: "https://example.com" })
mcp__playwright__snapshot({})
```

Expected: the navigate call returns successfully, and snapshot returns an accessibility tree / DOM summary for `example.com`. On the remote Chrome itself you should *see* the tab change (or open) — that's the strongest signal you're driving the right browser.

Then ask the user:

> Look at the Chrome window on `<HOST>` — do you see example.com in one of the tabs?

If yes: done. Tell them the agent now drives that Chrome instance for the rest of the session (and across restarts).

## Troubleshooting

**`ECONNREFUSED <HOST>:<PORT>`** — Chrome isn't listening, or it's bound to `127.0.0.1`. Re-launch Chrome with `--remote-debugging-address=0.0.0.0`, and double-check the port. From your container shell: `curl -sS http://<HOST>:<PORT>/json/version`.

**`getaddrinfo ENOTFOUND <HOST>`** — hostname isn't resolvable from inside the container. Use the IP address instead, or `host.docker.internal` if Chrome is on the Docker host.

**MCP tools missing after restart (`mcp__playwright__*` not in the tool list)** — registration didn't land. Check `ncl groups config get` for the `playwright` entry. If absent, the approval was rejected — re-run Phase 2 and ensure the admin approves. If present but tools still missing, check container logs (`logs/nanoclaw.log` and `data/v2-sessions/<group>/<session>/stderr.log`) for `pnpm dlx` install errors.

**Tools work but operate on a different browser than expected** — you connected to the right host but Chrome opened a fresh profile (without your `--user-data-dir`), or there are multiple Chrome processes on the host competing for the debug port. Quit *all* Chrome processes on the host, then relaunch with the desired `--user-data-dir`.

**`Target page, context or browser has been closed`** — the remote Chrome was quit (or crashed) after Playwright connected. Relaunch Chrome with the debug flags; no MCP re-registration needed, just retry the call.

**`pnpm dlx` fails to install on container start** — usually a transient network problem on first launch; restart the container. If it persists, the container's outbound network or pnpm cache is misconfigured — check `logs/nanoclaw.log`.

## Removal

When you no longer want the remote-browser integration:

```bash
ncl groups config remove-mcp-server --id <group-id> --name playwright
```

(From inside the container, `--id` auto-fills.) This triggers a config update and container restart, after which the `mcp__playwright__*` tools disappear. The remote Chrome is unaffected — quit it manually if you no longer need the debug port open.

## Notes

- **Per agent group.** This wiring is scoped to the agent group whose container called `add_mcp_server`. Repeat the skill from each group you want to give browser access.
- **CDP endpoint is baked into args.** If the remote Chrome moves to a different host or port, you have to remove and re-add the MCP server with the new URL — the entry stored in `container_configs.mcp_servers` is the literal arg list. There's no env-var indirection today.
- **Playwright MCP version.** `@latest` is convenient for tracking upstream but means a fresh `pnpm dlx` install on each container restart could fetch a newer version mid-session if a new release was published. Pin to a known version (e.g. `@playwright/mcp@<x.y.z>`) once you've confirmed a release works for your use.

## References

- Upstream MCP server: [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) (Microsoft).
- Chrome remote debugging protocol: [Chrome DevTools Protocol — Connecting](https://chromedevtools.github.io/devtools-protocol/).
- Self-mod tool reference: `container/agent-runner/src/mcp-tools/self-mod.ts` (`add_mcp_server`).
- Skill pattern modeled on `/add-ollama-tool` (instructions-only) and `/add-atomic-chat-tool` (MCP-server wiring).
