# WeChat Work Azure Relay

Azure Function 用于接收企业微信的回调消息，解密后转发到 Clawdbot。

## 为什么需要这个？

企业微信的回调消息使用 AES-256-CBC 加密，需要特定的解密流程。这个 Azure Function 作为中间层：

1. 接收企业微信的加密消息
2. 验证签名并解密
3. 转发明文 JSON 消息到 Clawdbot 的 webhook

## 快速部署

### 1. 安装依赖

```bash
cd azure-relay
npm install
```

### 2. 配置本地环境（可选，用于本地测试）

```bash
cp local.settings.json.example local.settings.json
# 编辑 local.settings.json 填入实际值
```

### 3. 部署到 Azure

```bash
# 确保已登录 Azure CLI
az login

# 部署（使用 --no-zip 参数很重要！）
npm run deploy
# 或
func azure functionapp publish YOUR_FUNCTION_APP_NAME --javascript --no-zip
```

### 4. 配置 Azure Function 环境变量

在 Azure Portal 中配置 Application Settings：

| 变量 | 必需 | 说明 |
|------|------|------|
| `WECHAT_TOKEN` | ✅ | 企业微信后台配置的 Token |
| `WECHAT_ENCODING_AES_KEY` | ✅ | 企业微信后台配置的 EncodingAESKey (43位) |
| `WECHAT_CORP_ID` | ✅ | 企业ID (corpid) |
| `CLAWDBOT_WEBHOOK_URL` | ✅ | Clawdbot 的 webhook 地址，如 `http://your-ip:3000/wechat-webhook` |
| `CLAWDBOT_WEBHOOK_SECRET` | ❌ | 可选的 webhook 密钥 |

### 5. 配置企业微信

1. 登录企业微信管理后台 https://work.weixin.qq.com
2. 进入「应用管理」→ 选择你的应用
3. 在「接收消息」设置中配置：
   - **URL**: `https://YOUR_FUNCTION_APP.azurewebsites.net/api/wechat`
   - **Token**: 与 `WECHAT_TOKEN` 相同
   - **EncodingAESKey**: 与 `WECHAT_ENCODING_AES_KEY` 相同（可点击随机生成）
4. 点击保存，企业微信会发送验证请求

## 本地测试

```bash
# 启动本地函数
npm start

# 测试 URL 验证
curl "http://localhost:7071/api/wechat?echostr=test"
```

## 转发的消息格式

转发到 Clawdbot 的 JSON 消息格式：

```json
{
  "type": "wechat-work-message",
  "fromUser": "UserID",
  "toUser": "CorpID",
  "msgType": "text",
  "content": "消息内容",
  "msgId": "消息ID",
  "agentId": "应用AgentID",
  "createTime": "1234567890",
  "timestamp": 1234567890000
}
```

## 故障排查

### 验证失败 (403)
- 检查 Token 是否与企业微信后台配置一致
- 检查 EncodingAESKey 是否正确（43位）
- 检查 CorpID 是否正确

### 解密失败 (400)
- 检查 EncodingAESKey 是否完整（43位）
- 确认收到的是有效的加密消息

### 转发失败
- 检查 CLAWDBOT_WEBHOOK_URL 是否可访问
- 检查 Clawdbot Gateway 是否运行
- 查看 Azure Function 日志

## 架构图

详见 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)
