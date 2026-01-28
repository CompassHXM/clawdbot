# WeChat Work Azure Function Relay

接收企业微信回调消息，解密后转发到 Clawdbot；并提供应用主页 (快捷指令)。

## 功能

| 端点 | 说明 |
|------|------|
| `GET/POST /api/wechat` | 企业微信消息回调 |
| `GET /api/jssdk-config` | JS-SDK 签名配置 |
| `GET /api/home` | 应用主页 (快捷指令按钮) |

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `WECHAT_TOKEN` | ✅ | 企业微信后台配置的 Token |
| `WECHAT_ENCODING_AES_KEY` | ✅ | 43位 EncodingAESKey |
| `WECHAT_CORP_ID` | ✅ | 企业ID |
| `WECHAT_SECRET` | ✅ | 应用 Secret (用于获取 access_token) |
| `WECHAT_AGENT_ID` | ✅ | 应用 AgentId |
| `CLAWDBOT_WEBHOOK_URL` | ✅ | Clawdbot webhook 地址 |
| `CLAWDBOT_WEBHOOK_SECRET` | | Webhook 密钥 (可选) |

## 本地开发

```bash
# 1. 复制配置文件
cp local.settings.json.example local.settings.json

# 2. 编辑 local.settings.json，填入真实值

# 3. 安装依赖
npm install

# 4. 启动
func start
```

## 部署到 Azure

```bash
# 1. 登录 Azure
az login

# 2. 部署 (使用 --no-zip 避免打包问题)
func azure functionapp publish <function-app-name> --javascript --no-zip

# 3. 配置环境变量 (Azure Portal → Function App → Configuration)
```

## 企业微信后台配置

### 1. 消息回调配置

**应用管理 → 自建应用 → 接收消息 → 设置 API 接收**

- URL: `https://<your-function>.azurewebsites.net/api/wechat`
- Token: 与环境变量 `WECHAT_TOKEN` 一致
- EncodingAESKey: 与环境变量 `WECHAT_ENCODING_AES_KEY` 一致

### 2. 应用主页配置

**应用管理 → 自建应用 → 应用主页**

- 主页 URL: `https://<your-function>.azurewebsites.net/api/home`

### 3. 可信域名配置 (用于 JS-SDK)

**应用管理 → 自建应用 → 开发者接口 → 网页授权及JS-SDK**

- 可信域名: `<your-function>.azurewebsites.net`

## 应用主页功能

主页提供以下快捷指令按钮：

- 🌤️ 查天气
- 📅 今日日程
- 📧 查邮件
- 📝 快速记事
- ✅ 待办清单
- 自定义消息输入框

点击按钮后，消息通过 JS-SDK 直接发送到应用会话，由现有的消息流程处理。

## 架构

```
用户点击主页按钮
    ↓
/api/home (返回 H5 页面)
    ↓
页面加载 → /api/jssdk-config (获取签名)
    ↓
wx.config() 初始化
    ↓
用户点击 → wx.invoke('sendChatMessage')
    ↓
企业微信服务器 → /api/wechat (消息回调)
    ↓
解密 → 转发到 Clawdbot webhook
    ↓
Nova 处理并回复
```

## 注意事项

1. **单文件结构**: 所有代码在 `index.js` 中，避免 Azure 多文件加载问题
2. **缓存**: `access_token` 和 `jsapi_ticket` 自动缓存，减少 API 调用
3. **部署**: 必须使用 `--no-zip` 参数
