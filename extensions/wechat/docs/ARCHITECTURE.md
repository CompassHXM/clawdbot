# WeChat Work Channel - 架构设计文档

## 概述

WeChat Work (企业微信) Channel 是 Clawdbot 的一个扩展插件，允许用户通过企业微信与 AI 助手进行对话。由于企业微信的安全要求（消息加密）和网络限制，架构采用了 Azure Function 作为中间层。

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WeChat Work Channel 架构                            │
└─────────────────────────────────────────────────────────────────────────────────┘

                                    用户视角
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              企业微信 App                                        │
│                         (iOS / Android / Desktop)                               │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                         ① 用户发送消息 │ ⑥ 收到回复
                           (AES加密)   │   (明文)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           企业微信服务器                                          │
│                    (腾讯云 - qyapi.weixin.qq.com)                                │
│  ┌─────────────────┐                              ┌─────────────────┐           │
│  │  消息加密/签名   │                              │   消息推送 API   │           │
│  │  (AES-256-CBC)  │                              │  /message/send  │           │
│  └─────────────────┘                              └─────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────────┘
          │                                                    ▲
          │ ② 推送加密消息                          ⑤ 发送回复 │
          │    (HTTP POST)                         (HTTP POST) │
          ▼                                                    │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         Azure Function (Relay)                                   │
│                 <your-function-app>.azurewebsites.net                           │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────┐           │
│  │                        /api/wechat                                │           │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │           │
│  │  │ 签名验证     │→│ AES 解密    │→│ XML 解析    │               │           │
│  │  │ (SHA1)      │  │ (256-CBC)   │  │             │               │           │
│  │  └─────────────┘  └─────────────┘  └─────────────┘               │           │
│  │                                            │                      │           │
│  │                                            ▼                      │           │
│  │                              ┌─────────────────────┐              │           │
│  │                              │   转发 JSON 消息     │              │           │
│  │                              │   到 Clawdbot       │              │           │
│  │                              └─────────────────────┘              │           │
│  └──────────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                          ③ 转发明文消息 │ (HTTP POST, JSON)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Clawdbot Gateway                                    │
│                          (your server - <your-ip>)                              │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                         WeChat Plugin                                       │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │ │
│  │  │  Webhook Handler │  │  Message Router  │  │  Outbound Sender │            │ │
│  │  │  /wechat-webhook │  │                  │  │                  │            │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘            │ │
│  │          │                    │                    ▲                       │ │
│  │          ▼                    ▼                    │                       │ │
│  │  ┌─────────────────────────────────────────────────────────────┐          │ │
│  │  │                    Session Manager                          │          │ │
│  │  │  • DM Policy (open/pairing/closed)                          │          │ │
│  │  │  • Session Routing                                          │          │ │
│  │  │  • Message Formatting                                       │          │ │
│  │  └─────────────────────────────────────────────────────────────┘          │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                       │                                          │
│                          ④ Agent 处理 │                                          │
│                                       ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                           AI Agent                                          │ │
│  │                    (Claude / GPT / etc.)                                    │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘


消息流程：
  ① 用户在企业微信发送消息
  ② 企业微信服务器将加密消息推送到 Azure Function
  ③ Azure Function 解密后转发到 Clawdbot
  ④ Clawdbot 路由到 Agent 处理
  ⑤ Agent 回复通过企业微信 API 发送
  ⑥ 用户在企业微信收到回复
```

## 组件说明

### 1. Azure Function Relay (`/api/wechat`)

**位置**: `https://<your-function-app>.azurewebsites.net/api/wechat`

**职责**:
- 接收企业微信服务器的回调请求
- 验证消息签名（防止伪造请求）
- 解密 AES 加密的消息内容
- 解析 XML 格式的消息
- 将明文消息转发到 Clawdbot

**为什么需要这个组件**:
1. **安全要求**: 企业微信的消息使用 AES-256-CBC 加密，需要专门的解密逻辑
2. **公网访问**: 企业微信需要能访问的公网 HTTPS 端点
3. **解耦**: 将加解密逻辑与 Clawdbot 核心分离，便于维护

**环境变量**:
| 变量 | 说明 |
|------|------|
| `WECHAT_TOKEN` | 企业微信后台配置的 Token |
| `WECHAT_ENCODING_AES_KEY` | 43位 EncodingAESKey |
| `WECHAT_CORP_ID` | 企业ID |
| `CLAWDBOT_WEBHOOK_URL` | Clawdbot webhook 地址 |

**代码文件**: `azure-relay/index.js`

---

### 2. WeChat Plugin (Clawdbot Extension)

**位置**: `extensions/wechat/`

**职责**:
- 注册 webhook 端点接收来自 Azure Function 的消息
- 管理用户 session 和 DM 策略
- 调用企业微信 API 发送回复消息
- 处理 access_token 缓存和刷新

**核心文件**:

| 文件 | 职责 |
|------|------|
| `src/channel.ts` | Channel 插件定义、API 调用、配置 schema |
| `src/monitor.ts` | Webhook 处理、消息路由、Agent 调度 |
| `src/runtime.ts` | Clawdbot 运行时接口 |
| `index.ts` | 插件入口、HTTP route 注册 |

---

### 3. 企业微信 API

**基础 URL**: `https://qyapi.weixin.qq.com/cgi-bin`

**使用的 API**:

| API | 用途 |
|-----|------|
| `/gettoken` | 获取 access_token |
| `/message/send` | 发送应用消息 |

**认证流程**:
```
corpId + secret → access_token (有效期 7200 秒，缓存复用)
```

---

## 数据流详解

### 入站消息 (用户 → AI)

```
1. 用户在企业微信发送 "你好"
   ↓
2. 企业微信服务器加密消息:
   POST /api/wechat?msg_signature=xxx&timestamp=xxx&nonce=xxx
   Body: <xml><Encrypt>BASE64_AES_ENCRYPTED</Encrypt></xml>
   ↓
3. Azure Function 处理:
   a. 验证签名: SHA1(sort([token, timestamp, nonce, encrypt]))
   b. 解密: AES-256-CBC(key, iv, base64decode(encrypt))
   c. 解析: <xml><FromUserName>xxx</FromUserName><Content>你好</Content>...</xml>
   d. 转发: POST /wechat-webhook { type: "wechat-work-message", fromUser: "xxx", content: "你好" }
   ↓
4. Clawdbot 处理:
   a. 验证 DM 策略 (open/pairing/allowlist)
   b. 路由到对应 session
   c. 格式化 envelope 发送给 Agent
   ↓
5. Agent 生成回复
```

### 出站消息 (AI → 用户)

```
1. Agent 生成回复 "你好！有什么可以帮你的吗？"
   ↓
2. Clawdbot outbound.sendText():
   a. 获取 access_token (缓存或刷新)
   b. 调用企业微信 API:
      POST /message/send?access_token=xxx
      Body: { touser: "xxx", msgtype: "text", agentid: YOUR_AGENT_ID, text: { content: "你好！..." } }
   ↓
3. 企业微信服务器推送到用户 App
```

---

## 配置说明

### Clawdbot 配置 (`clawdbot.json`)

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "webhookPath": "/wechat-webhook",
      "corpId": "YOUR_CORP_ID",
      "agentId": "YOUR_AGENT_ID",
      "secret": "YOUR_APP_SECRET",
      "dm": {
        "enabled": true,
        "policy": "open",
        "allowFrom": ["*"]
      }
    }
  },
  "plugins": {
    "entries": {
      "wechat": { "enabled": true }
    }
  }
}
```

### 企业微信后台配置

1. **应用管理** → 选择应用
2. **接收消息** → 设置 API 接收:
   - URL: `https://<your-function-app>.azurewebsites.net/api/wechat`
   - Token: `YOUR_TOKEN`
   - EncodingAESKey: `YOUR_ENCODING_AES_KEY` (43位)

---

## 安全考虑

1. **消息加密**: 所有入站消息使用 AES-256-CBC 加密
2. **签名验证**: 每个请求都验证 SHA1 签名防止伪造
3. **HTTPS**: 所有通信使用 HTTPS
4. **Token 安全**: access_token 服务端缓存，不暴露给客户端
5. **DM 策略**: 支持 open/pairing/closed 三种访问控制模式

---

## 部署清单

| 组件 | 位置 | 状态 |
|------|------|------|
| Azure Function | `<your-function-app>.azurewebsites.net` | 待部署 |
| Clawdbot Plugin | `extensions/wechat/` | 待启用 |
| Webhook Endpoint | `<your-ip>:3000/wechat-webhook` | 待配置 |
| 企业微信回调 | 企业微信后台配置 | 待验证 |

---

## 故障排查

### 消息发不出去
1. 检查 `corpId`, `agentId`, `secret` 是否正确
2. 检查 access_token 是否过期
3. 查看 Clawdbot 日志: `clawdbot logs`

### 收不到消息
1. 检查 Azure Function 日志
2. 验证企业微信后台回调 URL 配置
3. 检查 Token 和 EncodingAESKey 是否匹配

### 签名验证失败
1. 确认 Token 配置一致
2. 检查时间戳是否同步
3. 确认 URL 编码正确
