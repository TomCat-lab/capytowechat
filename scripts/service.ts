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
const MAX_HISTORY_PER_USER = 20;
const LONG_POLL_MS = 35_000;
const MAX_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const MAX_INPUT_LENGTH = 4_000;

// ── Mode: casual (chat) or work (full agent) ──────────────────────────────

type UserMode = "casual" | "work";
const userModes = new Map<string, UserMode>();

function getMode(userId: string): UserMode {
  return userModes.get(userId) ?? "casual";
}

// Keywords to switch modes — matched against the full trimmed message
const WORK_TRIGGERS  = /^(干活|工作|开工|工作模式|干活模式|#工作|#干活|work)$/i;
const CASUAL_TRIGGERS = /^(休闲|聊天|放松|休息|休闲模式|聊天模式|#休闲|#聊天|casual)$/i;

// Prompts
const CASUAL_SYSTEM_PROMPT = `你是 Capy，一个友好、智能的 AI 助手，通过微信与用户聊天。
规则：
- 用简洁清晰的中文回复，除非用户使用其他语言
- 不使用 Markdown 格式（微信不渲染它），用纯文本
- 保持回复简短自然，像真实朋友聊天一样`;

const WORK_SYSTEM_PROMPT = `你是 Capy，一个可以真正动手干活的 AI 助手，通过微信接收任务。
规则：
- 用简洁清晰的中文回复，除非用户使用其他语言
- 不使用 Markdown 格式（微信不渲染），用纯文本
- 可以写代码、执行脚本、读写文件、搜索内容来完成用户任务
- 执行完后，用一两句话告诉用户结果`;

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

// ── Casual mode: AI Gateway (fast chat) ──────────────────────────────────

const AI_GATEWAY_URL = "https://ai-gateway.happycapy.ai/api/v1/chat/completions";
const AI_MODEL = "anthropic/claude-sonnet-4.6";
const WEB_MODEL = "perplexity/sonar"; // online model with real-time web access

// Detect if a message likely needs web search
const WEB_SEARCH_RE = /最新|今天|今日|现在|最近|新闻|天气|股价|汇率|比赛|比分|上映|发布|搜索|查一下|帮我查|联网|网上|搜一下/;

type Role = "user" | "assistant";
type Message = { role: Role; content: string };
const histories = new Map<string, Message[]>();

function getHistory(userId: string): Message[] {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId)!;
}
function addMessage(userId: string, role: Role, content: string) {
  const h = getHistory(userId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY_PER_USER) h.splice(0, h.length - MAX_HISTORY_PER_USER);
}

async function askCasual(userId: string, userMessage: string): Promise<string> {
  const safeInput = userMessage.trim().slice(0, MAX_INPUT_LENGTH);
  addMessage(userId, "user", safeInput);

  // Use online model when query needs web search; otherwise use standard model
  const needsWeb = WEB_SEARCH_RE.test(safeInput);
  const model = needsWeb ? WEB_MODEL : AI_MODEL;

  const resp = await fetch(AI_GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: needsWeb
        // perplexity/sonar doesn't support system messages with history well; send just the query
        ? [{ role: "user", content: `${safeInput}\n\n（回复请用中文，不要用 Markdown，直接纯文本，简洁）` }]
        : [
            { role: "system", content: CASUAL_SYSTEM_PROMPT },
            ...getHistory(userId),
          ],
      max_tokens: 800,
    }),
  });

  if (!resp.ok) throw new Error(`AI Gateway HTTP ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const reply = data.choices?.[0]?.message?.content?.trim() || "抱歉，我现在无法回复，请稍后再试。";
  addMessage(userId, "assistant", reply);
  return reply;
}

// ── Work mode: claude -p with full tools ─────────────────────────────────

// Maps WeChat userId -> claude session ID for --resume support
const claudeSessions = new Map<string, string>();

async function askWork(userId: string, userMessage: string): Promise<string> {
  const safeInput = userMessage.trim().slice(0, MAX_INPUT_LENGTH);
  const sessionId = claudeSessions.get(userId);

  const args = [
    "-p",
    "--output-format", "json",
    "--system", WORK_SYSTEM_PROMPT,
    "--allowedTools", "Bash,Read,Write,Glob,Grep,Edit,WebFetch",
  ];
  if (sessionId) args.push("--resume", sessionId);

  const proc = Bun.spawn(["claude", ...args], {
    stdin: new TextEncoder().encode(safeInput),
    stdout: "pipe",
    stderr: "pipe",
    cwd: WORKSPACE_DIR,
    env: { ...process.env },
  });

  const timeoutHandle = setTimeout(() => {
    proc.kill();
    log(`超时终止 claude 进程: user=${userId.split("@")[0]}`);
  }, 120_000);

  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeoutHandle);
  await proc.exited;

  try {
    const parsed = JSON.parse(stdout) as { result?: string; session_id?: string; is_error?: boolean };
    if (parsed.session_id) claudeSessions.set(userId, parsed.session_id);
    if (parsed.is_error) return "抱歉，执行出错了，请稍后再试。";
    return parsed.result?.trim() || "抱歉，我现在无法回复，请稍后再试。";
  } catch {
    return stdout.trim() || "抱歉，我现在无法回复，请稍后再试。";
  }
}

// ── Unified entry: route by mode, handle mode-switch commands ─────────────

async function askAI(
  userId: string,
  userMessage: string,
): Promise<{ reply: string; modeChanged?: UserMode }> {
  const trimmed = userMessage.trim();

  if (WORK_TRIGGERS.test(trimmed)) {
    userModes.set(userId, "work");
    claudeSessions.delete(userId); // fresh session in new mode
    return {
      reply: "已切换到干活模式，我可以写代码、执行脚本、读写文件了。\n\n说「休闲」可以切回聊天模式。",
      modeChanged: "work",
    };
  }
  if (CASUAL_TRIGGERS.test(trimmed)) {
    userModes.set(userId, "casual");
    histories.delete(userId); // fresh history
    return {
      reply: "已切换到休闲模式，咱们来聊天吧。\n\n说「干活」可以切回干活模式。",
      modeChanged: "casual",
    };
  }

  const mode = getMode(userId);
  const reply = mode === "work"
    ? await askWork(userId, trimmed)
    : await askCasual(userId, trimmed);
  return { reply };
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

interface ImageItem {
  cdn_url?: string;   // primary CDN URL (if available)
  url?: string;       // fallback URL
  thumb_url?: string; // thumbnail URL
  size?: number;
  aes_key?: string;   // present if image is encrypted
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: ImageItem;
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
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_STATE_FINISH = 2;

// Parsed message: text content + optional image for vision models
interface ParsedMessage {
  text: string;
  imageBase64?: string; // base64-encoded image bytes
  imageMime?: string;   // e.g. "image/jpeg"
}

async function downloadImageAsBase64(url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type") ?? "image/jpeg";
    const buf = await resp.arrayBuffer();
    return { data: Buffer.from(buf).toString("base64"), mime: mime.split(";")[0] };
  } catch {
    return null;
  }
}

async function extractMessage(msg: WeixinMessage): Promise<ParsedMessage> {
  for (const item of msg.item_list ?? []) {
    // Log raw item types for debugging unknown types (no content logged)
    if (item.type !== MSG_ITEM_TEXT && item.type !== MSG_ITEM_VOICE && item.type !== MSG_ITEM_IMAGE) {
      log(`未知消息类型: type=${item.type} keys=${Object.keys(item).join(",")}`);
    }

    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      return { text: item.text_item.text };
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return { text: item.voice_item.text };
    }
    if (item.type === MSG_ITEM_IMAGE) {
      const imgItem = item.image_item;
      const url = imgItem?.cdn_url ?? imgItem?.url ?? imgItem?.thumb_url;
      const encrypted = !!imgItem?.aes_key;
      log(`收到图片消息: has_url=${!!url} encrypted=${encrypted} keys=${Object.keys(imgItem ?? {}).join(",")}`);
      if (url && !encrypted) {
        const img = await downloadImageAsBase64(url);
        if (img) return { text: "[图片]", imageBase64: img.data, imageMime: img.mime };
      }
      if (encrypted) return { text: "[图片（加密，暂不支持识别）]" };
      return { text: "[图片]" };
    }
  }
  return { text: "" };
}

// ── Vision: describe image via claude-sonnet-4.6 (multimodal) ────────────

async function describeImage(
  userId: string,
  imageBase64: string,
  imageMime: string,
  userText: string,
): Promise<string> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  const prompt = userText && userText !== "[图片]"
    ? userText
    : "请描述这张图片的内容。用中文，简洁自然，不用 Markdown。";

  const resp = await fetch(AI_GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL, // claude-sonnet-4.6 supports vision
      messages: [
        { role: "system", content: CASUAL_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: imageMime, data: imageBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_tokens: 600,
    }),
  });

  if (!resp.ok) throw new Error(`Vision API HTTP ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const reply = data.choices?.[0]?.message?.content?.trim() ?? "无法识别图片，请重试。";
  // Store reply in history for context
  addMessage(userId, "user", `[用户发送了一张图片] ${prompt}`);
  addMessage(userId, "assistant", reply);
  return reply;
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

        const parsed = await extractMessage(msg);
        if (!parsed.text.trim() && !parsed.imageBase64) continue;

        const senderId = msg.from_user_id ?? "unknown";

        if (msg.context_token) {
          contextTokens.set(senderId, msg.context_token);
        }

        // Log only non-sensitive metadata
        const msgKind = parsed.imageBase64 ? "图片" : "文字";
        log(`收到消息: from=${senderId.split("@")[0]} kind=${msgKind} len=${parsed.text.length}`);

        const contextToken = contextTokens.get(senderId);
        if (!contextToken) {
          log(`跳过 (无 context_token): ${senderId}`);
          continue;
        }

        // Call AI and reply
        try {
          // Image message: use vision model regardless of mode
          if (parsed.imageBase64) {
            await sendReply(baseUrl, token, senderId, "识别中，请稍候...", contextToken).catch(() => {});
            const reply = await describeImage(senderId, parsed.imageBase64, parsed.imageMime ?? "image/jpeg", parsed.text);
            await sendReply(baseUrl, token, senderId, reply, contextToken);
            log(`图片识别完成: to=${senderId.split("@")[0]} len=${reply.length}`);
            continue;
          }

          // Text message: route by mode
          if (getMode(senderId) === "work" && parsed.text.length > 10) {
            await sendReply(baseUrl, token, senderId, "正在处理，请稍候...", contextToken).catch(() => {});
          }
          const { reply } = await askAI(senderId, parsed.text);
          await sendReply(baseUrl, token, senderId, reply, contextToken);
          log(`已回复: to=${senderId.split("@")[0]} mode=${getMode(senderId)} len=${reply.length}`);
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
