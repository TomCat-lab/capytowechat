# Capy x WeChat AI Bot

把 Capy AI 接入微信，让微信直接变成 AI 对话窗口。

基于微信官方 **ClawBot ilink API**，每人独立账号，安全可靠。

## 效果

在微信里直接和 AI 对话，由 `claude-sonnet-4.6` 驱动，支持文字和语音消息。

## 安装

在 Capy 对话框直接说：

```
把微信和 Capy 连接
```

或者输入：

```
/capytowechat
```

Capy 会自动完成所有安装步骤，包括安装依赖、显示二维码（自动刷新）、启动后台服务。

## 安全保障

- 微信 token 仅存储在本地 `~/.capy/wechat/account.json`（权限 0600）
- AI 密钥只从环境变量读取，不写入任何文件
- 消息内容不记录日志，对话历史仅在内存中，重启即清除

## 技术架构

```
微信用户  →  ClawBot ilink API  →  capy-wechat 服务  →  Capy AI Gateway (claude-sonnet-4.6)  →  回复
```

## 文件说明

| 文件 | 说明 |
|------|------|
| `SKILL.md` | Capy Skill 主文件 |
| `scripts/setup.ts` | 微信 QR 认证脚本 |
| `scripts/service.ts` | 长轮询消息桥 |
| `scripts/package.json` | 依赖配置 |

## Requirements

- iOS 微信（最新版）
- Capy 沙盒（`AI_GATEWAY_API_KEY` 已自动配置）

