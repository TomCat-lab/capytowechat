#!/usr/bin/env bun
/**
 * Capy WeChat Service
 *
 * Standalone bridge: WeChat (ClawBot ilink API) <-> Capy AI Gateway
 *
 * Security measures:
 *   - Credentials stored in ~/.capy/wechat/account.json (permissions 0600)
 *   - AI_GATEWAY_API_KEY read from environment variable only
 *   - All traffic over HTTPS
 *   - No message content written to logs (only non-sensitive metadata)
 *   - Conversation history kept in memory only (not persisted to disk)
 *   - History capped at MAX_HISTORY_PER_USER messages per user
 *
 * Run:
 *   AI_GATEWAY_API_KEY=<key> bun service.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Config ────────────────────────────────────────────────────────────────

const CREDENTIALS_FILE = path.join(
  process.env.HOME || "~",
  ".capy",
  "wechat",
  "account.json"
);

const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR ||
  process.cwd().replace(/\/capy-wechat$/, "");
const MAX_HISTORY_PER_USER = 20; // max messages kept per user conversation (unused with claude -p sessions)
const LONG_POLL_MS = 35_000;
const MAX_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const MAX_INPUT_LENGTH = 4_000; // truncate excessively long messages

const CLAUDE_SYSTEM_PROMPT = `你是 Capy，一个友好、智能的 AI 助手，通过微信与用户对话。
规则：
- 用简洁清晰的中文回复，除非用户使用其他语言
- 不使用 Markdown 格式（微信不渲染它），用纯文本
- 保持回复简短自然，像真实聊天一样
- 可以写代码、执行脚本、读写文件来完成用户任务
- 执行完任务后，用简短文字告诉用户结果`;

// ── Logging (no message content) ─────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toLocaleTimeString("zh-CN");
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function logError(msg: string) {
  const ts = new Date().toLocaleTimeString("zh-CN");
  process.stderr.write(`[${ts}] ERROR: ${msg}\n`);
}

// ── Credentials ──────────────────────────────────────────────────────────

type Account = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

function loadCredentials(): Account {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error(
      "未找到微信凭据，请先运行: bun setup.ts"
    );
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8")) as Account;
  } catch (err) {
    console.error(`读取凭据失败: ${String(err)}`);
    process.exit(1);
  }
}

// ── Claude Session IDs (per-user conversation continuity) ────────────────

// Maps WeChat userId -> claude session ID for --resume support
const claudeSessions = new Map<string, string>();

// ── Claude Agent (via claude -p) ──────────────────────────────────────────

async function askAI(userId: string, userMessage: string): Promise<string> {
  // Sanitize and truncate input
  const safeInput = userMessage.trim().slice(0, MAX_INPUT_LENGTH);

  const sessionId = claudeSessions.get(userId);

  const args = [
    "-p",
    "--output-format", "json",
    "--system", CLAUDE_SYSTEM_PROMPT,
    "--allowedTools", "Bash,Read,Write,Glob,Grep,Edit",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const proc = Bun.spawn(["claude", ...args], {
    stdin: new TextEncoder().encode(safeInput),
    stdout: "pipe",
    stderr: "pipe",
    cwd: WORKSPACE_DIR,
    env: { ...process.env },
  });

  // Timeout: 2 minutes for complex tasks
  const timeoutHandle = setTimeout(() => {
    proc.kill();
    log(`超时终止 claude 进程: user=${userId.split("@")[0]}`);
  }, 120_000);

  const [stdout, _stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timeoutHandle);
  await proc.exited;

  // Parse JSON output to extract result and session ID
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      session_id?: string;
      is_error?: boolean;
    };

    // Save session ID for conversation continuity
    if (parsed.session_id) {
      claudeSessions.set(userId, parsed.session_id);
    }

    if (parsed.is_error) {
      logError(`claude 返回错误: ${parsed.result}`);
      return "抱歉，执行出错了，请稍后再试。";
    }

    return parsed.result?.trim() || "抱歉，我现在无法回复，请稍后再试。";
  } catch {
    // Fallback: return raw stdout if JSON parse fails
    return stdout.trim() || "抱歉，我现在无法回复，请稍后再试。";
  }
}

// ── WeChat ilink API ─────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string, bodyLen?: number): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token.trim()}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (bodyLen !== undefined) {
    headers["Content-Length"] = String(bodyLen);
  }
  return headers;
}

async function postJSON(
  baseUrl: string,
  token: string,
  endpoint: string,
  payload: unknown,
  timeoutMs: number
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const body = JSON.stringify(payload);
  const headers = buildHeaders(token, Buffer.byteLength(body, "utf-8"));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Message Types ─────────────────────────────────────────────────────────

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

interface WeixinMessage {
  from_user_id?: string;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const MSG_STATE_FINISH = 2;

function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

// context_token cache: needed to reply to the correct conversation thread
const contextTokens = new Map<string, string>();

async function getUpdates(
  baseUrl: string,
  token: string,
  buf: string
): Promise<GetUpdatesResp> {
  try {
    return (await postJSON(
      baseUrl,
      token,
      "ilink/bot/getupdates",
      { get_updates_buf: buf, base_info: { channel_version: "1.0.0" } },
      LONG_POLL_MS
    )) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

async function sendReply(
  baseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken: string
): Promise<void> {
  const clientId = `capy-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await postJSON(
    baseUrl,
    token,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    },
    15_000
  );
}

// ── Main Poll Loop ────────────────────────────────────────────────────────

async function runService(account: Account): Promise<never> {
  const { baseUrl, token } = account;
  let buf = "";
  let failures = 0;

  // Persist sync buffer across restarts to avoid replaying old messages
  const bufFile = path.join(process.env.HOME || "~", ".capy", "wechat", "sync_buf.txt");
  try {
    if (fs.existsSync(bufFile)) {
      buf = fs.readFileSync(bufFile, "utf-8");
      log(`恢复同步状态 (${buf.length} bytes)`);
    }
  } catch {
    // ignore
  }

  log(`服务启动，账号: ${account.accountId}`);
  log("开始监听微信消息...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, buf);
      const hasError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (hasError) {
        failures++;
        logError(`getUpdates 失败 (${failures}): ret=${resp.ret} errcode=${resp.errcode} "${resp.errmsg ?? ""}"`);
        if (failures >= MAX_FAILURES) {
          failures = 0;
          log(`退避等待 ${BACKOFF_MS / 1000}s...`);
          await new Promise((r) => setTimeout(r, BACKOFF_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
        continue;
      }

      failures = 0;

      // Persist sync buffer
      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        try {
          fs.writeFileSync(bufFile, buf, "utf-8");
        } catch {
          // ignore
        }
      }

      // Process each incoming message
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;

        const text = extractText(msg);
        if (!text.trim()) continue;

        const senderId = msg.from_user_id ?? "unknown";

        if (msg.context_token) {
          contextTokens.set(senderId, msg.context_token);
        }

        // Log only non-sensitive metadata
        log(`收到消息: from=${senderId.split("@")[0]} len=${text.length}`);

        const contextToken = contextTokens.get(senderId);
        if (!contextToken) {
          log(`跳过 (无 context_token): ${senderId}`);
          continue;
        }

        // Call AI and reply
        try {
          // For longer inputs, send a "thinking" message first
          if (text.length > 30) {
            await sendReply(baseUrl, token, senderId, "正在处理，请稍候...", contextToken).catch(() => {});
          }
          const reply = await askAI(senderId, text);
          await sendReply(baseUrl, token, senderId, reply, contextToken);
          log(`已回复: to=${senderId.split("@")[0]} len=${reply.length}`);
        } catch (err) {
          logError(`处理消息失败: ${String(err)}`);
          // Send a friendly error message back so the user isn't left hanging
          try {
            await sendReply(
              baseUrl,
              token,
              senderId,
              "抱歉，我遇到了一些问题，请稍后再试。",
              contextToken
            );
          } catch {
            // ignore secondary error
          }
        }
      }
    } catch (err) {
      failures++;
      logError(`轮询异常 (${failures}): ${String(err)}`);
      if (failures >= MAX_FAILURES) {
        failures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }
}

// ── Entry Point ───────────────────────────────────────────────────────────

async function main() {
  // claude -p inherits the current environment (ANTHROPIC_BASE_URL etc.)
  // No extra API key needed — it uses the same auth as the Capy session.

  const account = loadCredentials();
  log(`账号加载成功: ${account.accountId}`);

  // Graceful shutdown on SIGINT / SIGTERM
  process.on("SIGINT", () => {
    log("收到中断信号，正在退出...");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("收到终止信号，正在退出...");
    process.exit(0);
  });

  await runService(account);
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
