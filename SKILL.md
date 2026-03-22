---
name: capytowechat
description: >
  Connect Capy to WeChat so the user can chat with AI directly inside WeChat.
  Use this skill whenever the user wants to integrate WeChat with Capy or AI,
  asks how to use AI in WeChat, says "把微信和Capy连接", "微信接入AI",
  "WeChat bot", "微信机器人", "在微信里用AI", or invokes /capytowechat.
  Also trigger when the user wants to restart, check status, or stop the WeChat service.
---

# Capy ↔ WeChat Integration

This skill sets up a personal WeChat AI bot powered by Capy's AI Gateway.
Each user gets their own isolated bot — credentials and conversation history
are stored locally and never shared.

**Requirements:**
- iOS WeChat (latest version) — needed for QR scan
- `AI_GATEWAY_API_KEY` environment variable — already set in the Capy sandbox

---

## How it works

```
WeChat user sends message
      ↓
WeChat ClawBot ilink API (official WeChat bot API)
      ↓
capy-wechat service (long-polling, running in background)
      ↓
Capy AI Gateway → claude-sonnet-4.6
      ↓
Reply sent back to WeChat
```

**Security guarantees:**
- Your WeChat token is saved to `~/.capy/wechat/account.json` (permissions 0600, readable only by you)
- AI_GATEWAY_API_KEY is read from environment, never written to any file
- Message content is never logged — only non-sensitive metadata (user ID prefix, message length)
- Conversation history lives in memory only, cleared when service stops
- All traffic uses HTTPS

---

## Step 1 — Install the service files

Check if `capy-wechat/` already exists in the workspace. If not, set it up:

```bash
# Check bun runtime
export PATH="$HOME/.bun/bin:$PATH"
bun --version 2>/dev/null || curl -fsSL https://bun.sh/install | bash

export PATH="$HOME/.bun/bin:$PATH"

# Create project directory
WORKSPACE=$(pwd)
mkdir -p "$WORKSPACE/capy-wechat"
```

Copy the bundled scripts into the workspace project:

```bash
SKILL_DIR="$(dirname "$0")"  # resolved at runtime to the skill's own directory

cp "$SKILL_DIR/scripts/package.json" "$WORKSPACE/capy-wechat/package.json"
cp "$SKILL_DIR/scripts/setup.ts"    "$WORKSPACE/capy-wechat/setup.ts"
cp "$SKILL_DIR/scripts/service.ts"  "$WORKSPACE/capy-wechat/service.ts"

cd "$WORKSPACE/capy-wechat" && bun install
```

The scripts are in `scripts/` inside this skill directory. Use the `Read` tool
to find the skill's own path at runtime:
- `setup.ts` — one-time WeChat QR authentication
- `service.ts` — long-running message bridge

---

## Step 2 — Authenticate (first time only)

If `~/.capy/wechat/account.json` already exists, skip to Step 3.

Run setup in the background (it auto-refreshes the QR code every ~35 seconds
until the user scans it):

```bash
cd capy-wechat
export PATH="$HOME/.bun/bin:$PATH"
bun setup.ts > /tmp/wechat-setup.log 2>&1 &
echo "Setup PID: $!"
```

Wait ~3 seconds, then read the QR code image:
- QR is saved to `outputs/wechat-qr.png` in the workspace
- Use the `Read` tool to display it inline so the user can scan it
- Tell the user: "Please scan this with iOS WeChat → + → Scan, then tap Confirm"
- Keep polling `/tmp/wechat-setup.log` every few seconds to detect confirmation
- When log shows "微信连接成功", authentication is complete

```bash
# Poll for completion
tail -20 /tmp/wechat-setup.log
```

---

## Step 3 — Start the service

```bash
cd capy-wechat
export PATH="$HOME/.bun/bin:$PATH"
AI_GATEWAY_API_KEY="$AI_GATEWAY_API_KEY" bun service.ts > /tmp/wechat-service.log 2>&1 &
echo "Service PID: $!"
sleep 3
tail -5 /tmp/wechat-service.log
```

A healthy start looks like:
```
[HH:MM:SS] 账号加载成功: <bot-id>
[HH:MM:SS] 服务启动，账号: <bot-id>
[HH:MM:SS] 开始监听微信消息...
```

Tell the user: "WeChat is now connected. Send a message in WeChat and Capy will reply."

---

## Checking service status

```bash
tail -20 /tmp/wechat-service.log
ps aux | grep "bun service.ts" | grep -v grep
```

---

## Stopping the service

```bash
pkill -f "bun service.ts"
echo "Service stopped"
```

---

## Re-authenticating (if token expires)

Tokens are long-lived but may expire. If service logs show auth errors:

```bash
rm ~/.capy/wechat/account.json
# Then repeat Step 2
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| QR expired immediately | Scanned too slowly | QR auto-refreshes; scan the new one |
| No reply in WeChat | Service not started | Check `/tmp/wechat-service.log` |
| "AI_GATEWAY_API_KEY not set" | Env var missing | Restart session; key is auto-set in Capy |
| Auth errors after days | Token expired | Delete account.json and re-authenticate |

---

## Notes for the agent

- The bundled scripts contain **no personal data** — all credentials are dynamically
  generated per-user at authentication time
- `import.meta.dir` in setup.ts resolves relative to the script's location,
  so QR output lands in `workspace/outputs/wechat-qr.png` when run from `capy-wechat/`
- The service runs until the Capy session ends; users need to restart it each new session
  (no re-scan needed — credentials persist in `~/.capy/wechat/account.json`)
- Use `Read` tool to display the QR image inline; do not ask the user to open a file path
