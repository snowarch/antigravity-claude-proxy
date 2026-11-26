# Antigravity Claude Proxy

Anthropic-compatible local proxy backed by Google Cloud Code (Antigravity). Keeps your official Claude account untouched by running Claude Code through an isolated `claude-antigravity` command.

> **Warning:** Unofficial tool. Google may suspend accounts that violate its Terms of Service. Use a secondary Google account.

## What this fork adds

- **Native `WebSearch`**: maps Anthropic `web_search_*` server tools to Google Search grounding (`{ googleSearch: {} }`), resolves Vertex AI redirect URLs, and returns `server_tool_use` + `web_search_tool_result` blocks in both streaming and non-streaming modes. No MCP server needed.
- **Native `/voice` dictation**: implements `/api/ws/speech_to_text/voice_stream` (backed by Cloud Code Gemini audio transcription) plus a localhost-only `CONNECT` tunnel for `api.anthropic.com:443` with an auto-generated local CA (`~/.config/antigravity-proxy/certs/ca.pem`).
- **Isolated setup**: separate `CLAUDE_CONFIG_DIR` (`~/.claude-account-antigravity`) and wrapper command (`claude-antigravity`) so `~/.claude` stays clean for official Anthropic usage.

## 1. Install and start the proxy

Requires **Node.js >= 22.19.0**.

```bash
git clone https://github.com/snowarch/antigravity-claude-proxy.git ~/.local/src/antigravity-claude-proxy
cd ~/.local/src/antigravity-claude-proxy
npm install
npm start
```

The proxy listens on `http://localhost:8080`.

### Link a Google account

- **Web UI**: open `http://localhost:8080` → **Accounts** → **Add Account**.
- **CLI**: `npm run accounts:add` (add `-- --no-browser` on headless machines).

## 2. Run as a `systemd --user` service (Linux)

Create `~/.config/systemd/user/antigravity-proxy.service`:

```ini
[Unit]
Description=Antigravity Claude Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env node %h/.local/src/antigravity-claude-proxy/src/index.js
WorkingDirectory=%h
Environment=PORT=8080
Environment=NODE_ENV=production
Environment=CLAUDE_CONFIG_PATH=%h/.claude-account-antigravity
Restart=on-failure
RestartSec=5
KillMode=mixed

[Install]
WantedBy=default.target
```

Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now antigravity-proxy.service
```

Pointing `CLAUDE_CONFIG_PATH` to `~/.claude-account-antigravity` keeps the Web UI from modifying your official `~/.claude/settings.json`.

## 3. Set up the isolated `claude-antigravity` command

Do **not** export `ANTHROPIC_BASE_URL` globally in your shell or overwrite `~/.claude/settings.json`. Use an isolated launcher instead.

### Recommended: wrapper script (works in interactive and non-interactive shells)

Create `~/.local/bin/claude-antigravity` (make sure `~/.local/bin` is in `PATH`):

```bash
#!/usr/bin/env bash
exec env \
  -u ANTHROPIC_AUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$HOME/.claude-account-antigravity" \
  ANTHROPIC_BASE_URL="http://localhost:8080" \
  CLAUDE_CODE_OAUTH_TOKEN="antigravity-proxy" \
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
  HTTPS_PROXY="http://localhost:8080" \
  NO_PROXY="localhost,127.0.0.1" \
  NODE_EXTRA_CA_CERTS="$HOME/.config/antigravity-proxy/certs/ca.pem" \
  claude "$@"
```

```bash
chmod +x ~/.local/bin/claude-antigravity
```

### Alternative: shell alias (interactive shells only)

```bash
# ~/.bashrc or ~/.zshrc
alias claude-antigravity='env -u ANTHROPIC_AUTH_TOKEN CLAUDE_CONFIG_DIR="$HOME/.claude-account-antigravity" ANTHROPIC_BASE_URL="http://localhost:8080" CLAUDE_CODE_OAUTH_TOKEN="antigravity-proxy" CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 HTTPS_PROXY="http://localhost:8080" NO_PROXY="localhost,127.0.0.1" NODE_EXTRA_CA_CERTS="$HOME/.config/antigravity-proxy/certs/ca.pem" claude'
```

### Isolated settings file

Create `~/.claude-account-antigravity/settings.json` with your model mapping:

```json
{
  "model": "opus",
  "modelOverrides": {
    "claude-opus-5-5": "gemini-4-neon-high",
    "claude-sonnet-5-5": "gemini-4-neon-medium",
    "claude-haiku-5-5": "gemini-3.8-flash-low"
  },
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5-5"
  },
  "voice": {
    "enabled": true,
    "mode": "hold"
  },
  "voiceEnabled": true
}
```

> Use `VOICE_MODEL` in the proxy environment to override the default transcription model (`gemini-3.8-flash-low`). On Linux, `/voice` requires `arecord` (ALSA/PipeWire) or `sox`.

Use `claude` for your official Anthropic account and `claude-antigravity` for this proxy.

> If Claude asks for onboarding on first launch, add `"hasCompletedOnboarding": true` to `~/.claude-account-antigravity/.claude.json`.

## 4. Verify and inspect

```bash
# Proxy health
curl http://localhost:8080/health

# Quota table across accounts and models
curl "http://localhost:8080/account-limits?format=table"

# Available backend model IDs
curl -s http://localhost:8080/v1/models | jq -r '.data[].id'
```

## Updating

```bash
cd ~/.local/src/antigravity-claude-proxy
git pull --rebase
npm install
systemctl --user restart antigravity-proxy.service
```

## License

MIT — forked from [badrisnarayanan/antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy).
