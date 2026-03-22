#!/usr/bin/env bun
/**
 * Capy WeChat Setup — WeChat ClawBot QR login.
 *
 * Run this once before starting the service:
 *   bun setup.ts
 *
 * Saves credentials to ~/.capy/wechat/account.json (permissions 0600).
 * Saves QR code image to ../outputs/wechat-qr.png for easy scanning.
 */

import fs from "node:fs";
import path from "node:path";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CREDENTIALS_DIR = path.join(process.env.HOME || "~", ".capy", "wechat");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "account.json");
const QR_OUTPUT = path.join(import.meta.dir, "../outputs/wechat-qr.png");

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(): Promise<QRCodeResponse> {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: HTTP ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(qrcode: string): Promise<QRStatusResponse> {
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: HTTP ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function generateQRImage(content: string): Promise<void> {
  try {
    const QRCode = (await import("qrcode")).default;
    await QRCode.toFile(QR_OUTPUT, content, {
      type: "png",
      width: 300,
      margin: 2,
    });
    console.log(`\nQR 码图片已保存到: outputs/wechat-qr.png`);
    console.log("请在 Capy 预览中打开该图片，用 iOS 微信扫码\n");
  } catch {
    // Fallback to terminal QR
    try {
      const qrterm = (await import("qrcode-terminal")).default;
      await new Promise<void>((resolve) => {
        qrterm.generate(content, { small: true }, (qr: string) => {
          console.log(qr);
          resolve();
        });
      });
    } catch {
      console.log(`扫码链接: ${content}\n`);
    }
  }
}

async function main() {
  // Check for existing valid credentials
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
      console.log(`已有保存的账号 ID: ${existing.accountId}`);
      console.log(`保存时间: ${existing.savedAt}`);
      console.log("\n凭据已存在，无需重新登录。");
      console.log("如需重新登录，请先删除: ~/.capy/wechat/account.json");
      process.exit(0);
    } catch {
      // ignore, re-login
    }
  }

  // Auto-refresh loop: generate a new QR whenever expired
  while (true) {
    console.log("正在获取微信登录二维码...\n");
    const qrResp = await fetchQRCode();

    // Generate QR code image (overwrites previous file)
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    await generateQRImage(qrResp.qrcode_img_content);
    fs.writeFileSync(
      path.join(CREDENTIALS_DIR, "qr_updated_at.txt"),
      new Date().toISOString(),
      "utf-8"
    );
    console.log("等待扫码（二维码有效约 35 秒，过期自动刷新）...\n");

    let scannedPrinted = false;
    let shouldRefresh = false;

    while (!shouldRefresh) {
      const status = await pollQRStatus(qrResp.qrcode);

      switch (status.status) {
        case "wait":
          process.stdout.write(".");
          break;

        case "scaned":
          if (!scannedPrinted) {
            console.log("\n已扫码，请在微信中点击确认...");
            scannedPrinted = true;
          }
          break;

        case "expired":
          console.log("\n二维码已过期，自动获取新二维码...\n");
          shouldRefresh = true;
          break;

        case "confirmed": {
          if (!status.ilink_bot_id || !status.bot_token) {
            console.error("\n登录失败：服务器未返回完整信息。");
            process.exit(1);
          }

          const account = {
            token: status.bot_token,
            baseUrl: status.baseurl || BASE_URL,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            savedAt: new Date().toISOString(),
          };

          fs.writeFileSync(
            CREDENTIALS_FILE,
            JSON.stringify(account, null, 2),
            "utf-8"
          );
          try {
            fs.chmodSync(CREDENTIALS_FILE, 0o600);
          } catch {
            // best-effort
          }

          console.log(`\n微信连接成功！`);
          console.log(`  账号 ID : ${account.accountId}`);
          console.log(`  用户 ID : ${account.userId}`);
          console.log(`  凭据保存: ~/.capy/wechat/account.json`);
          console.log(`\n现在可以启动服务：bun start\n`);
          process.exit(0);
        }
      }

      if (!shouldRefresh) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }
}

main().catch((err) => {
  console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
