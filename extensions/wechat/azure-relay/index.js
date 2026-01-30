/**
 * WeChat Work Relay - Azure Function
 * 
 * 功能:
 * 1. /api/wechat - 接收企业微信的回调消息，解密后转发到 Clawdbot webhook
 * 2. /api/jssdk-config - 提供 JS-SDK 签名配置
 * 3. /api/home - 应用主页（快捷指令）
 * 
 * 环境变量:
 * - WECHAT_TOKEN: 企业微信后台配置的 Token
 * - WECHAT_ENCODING_AES_KEY: 企业微信后台配置的 EncodingAESKey (43位)
 * - WECHAT_CORP_ID: 企业ID (corpid)
 * - WECHAT_SECRET: 应用的 Secret (用于获取 access_token)
 * - WECHAT_AGENT_ID: 应用的 AgentId
 * - CLAWDBOT_WEBHOOK_URL: Clawdbot webhook 地址
 * - CLAWDBOT_WEBHOOK_SECRET: (可选) Webhook 密钥
 */

const { app } = require("@azure/functions");
const crypto = require("crypto");

// ============================================================================
// 缓存
// ============================================================================

// access_token 缓存 (有效期 7200 秒)
let accessTokenCache = {
  token: null,
  expiresAt: 0,
};

// jsapi_ticket 缓存 (有效期 7200 秒)
let jsapiTicketCache = {
  ticket: null,
  expiresAt: 0,
};

// ============================================================================
// WeChat Crypto 实现
// 参考: https://developer.work.weixin.qq.com/document/path/90968
// ============================================================================

class WxBizMsgCrypt {
  constructor(config) {
    this.token = config.token;
    this.corpId = config.corpId;
    // EncodingAESKey 是 Base64 编码的 AES 密钥，长度为 43，解码后为 32 字节
    this.aesKey = Buffer.from(config.encodingAESKey + "=", "base64");
  }

  /**
   * 验证签名
   */
  verifySignature(signature, timestamp, nonce, echostr) {
    const arr = [this.token, timestamp, nonce, echostr].sort();
    const str = arr.join("");
    const hash = crypto.createHash("sha1").update(str).digest("hex");
    return hash === signature;
  }

  /**
   * 验证 URL 回调
   */
  verifyUrl(msgSignature, timestamp, nonce, echostr) {
    if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
      return null;
    }
    return this.decrypt(echostr);
  }

  /**
   * 解密消息
   */
  decrypt(encrypted) {
    try {
      const iv = this.aesKey.subarray(0, 16);
      const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, iv);
      decipher.setAutoPadding(false);

      let decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
        decipher.final(),
      ]);

      // PKCS7 去填充
      const pad = decrypted[decrypted.length - 1];
      decrypted = decrypted.subarray(0, decrypted.length - pad);

      // 解析结构
      const msgLen = decrypted.readUInt32BE(16);
      const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
      const receivedCorpId = decrypted.subarray(20 + msgLen).toString("utf8");

      if (receivedCorpId !== this.corpId) {
        console.error("CorpId mismatch: expected " + this.corpId + ", got " + receivedCorpId);
        return null;
      }

      return msg;
    } catch (err) {
      console.error("Decrypt error:", err);
      return null;
    }
  }
}

// ============================================================================
// XML 解析
// ============================================================================

function parseXml(xml) {
  const extract = (tag) => {
    const match = new RegExp("<" + tag + "><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></" + tag + ">").exec(xml);
    return match ? match[1] : undefined;
  };
  const extractNum = (tag) => {
    const match = new RegExp("<" + tag + ">(\\d+)</" + tag + ">").exec(xml);
    return match ? match[1] : undefined;
  };

  return {
    ToUserName: extract("ToUserName"),
    FromUserName: extract("FromUserName"),
    CreateTime: extractNum("CreateTime"),
    MsgType: extract("MsgType"),
    Content: extract("Content"),
    MsgId: extract("MsgId") || extractNum("MsgId"),
    AgentID: extract("AgentID") || extractNum("AgentID"),
    Event: extract("Event"),
    EventKey: extract("EventKey"),
    PicUrl: extract("PicUrl"),
    MediaId: extract("MediaId"),
  };
}

// ============================================================================
// 配置管理
// ============================================================================

function getConfig() {
  const token = process.env.WECHAT_TOKEN;
  const encodingAESKey = process.env.WECHAT_ENCODING_AES_KEY;
  const corpId = process.env.WECHAT_CORP_ID;
  const secret = process.env.WECHAT_SECRET;
  const agentId = process.env.WECHAT_AGENT_ID;
  const webhookUrl = process.env.CLAWDBOT_WEBHOOK_URL;
  const webhookSecret = process.env.CLAWDBOT_WEBHOOK_SECRET;

  return { token, encodingAESKey, corpId, secret, agentId, webhookUrl, webhookSecret };
}

// ============================================================================
// 企业微信 API
// ============================================================================

const WECHAT_API = "https://qyapi.weixin.qq.com/cgi-bin";

/**
 * 获取 access_token (带缓存)
 */
async function getAccessToken(corpId, secret, context) {
  const now = Date.now();
  
  // 检查缓存 (提前 5 分钟过期)
  if (accessTokenCache.token && accessTokenCache.expiresAt > now + 300000) {
    context.log("Using cached access_token");
    return accessTokenCache.token;
  }

  context.log("Fetching new access_token");
  const url = `${WECHAT_API}/gettoken?corpid=${corpId}&corpsecret=${secret}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`gettoken failed: ${data.errmsg} (${data.errcode})`);
  }

  accessTokenCache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return data.access_token;
}

/**
 * 获取 jsapi_ticket (带缓存)
 */
async function getJsapiTicket(accessToken, context) {
  const now = Date.now();
  
  // 检查缓存 (提前 5 分钟过期)
  if (jsapiTicketCache.ticket && jsapiTicketCache.expiresAt > now + 300000) {
    context.log("Using cached jsapi_ticket");
    return jsapiTicketCache.ticket;
  }

  context.log("Fetching new jsapi_ticket");
  const url = `${WECHAT_API}/get_jsapi_ticket?access_token=${accessToken}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`get_jsapi_ticket failed: ${data.errmsg} (${data.errcode})`);
  }

  jsapiTicketCache = {
    ticket: data.ticket,
    expiresAt: now + data.expires_in * 1000,
  };

  return data.ticket;
}

/**
 * 生成 JS-SDK 签名
 */
function generateJssdkSignature(ticket, nonceStr, timestamp, url) {
  const rawString = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  return crypto.createHash("sha1").update(rawString).digest("hex");
}

/**
 * 生成随机字符串
 */
function generateNonceStr(length = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ============================================================================
// 媒体下载
// ============================================================================

// 图片大小限制 (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/**
 * 下载媒体文件
 * @param {string} mediaId - 媒体文件 ID
 * @param {string} accessToken - access_token
 * @param {object} context - Azure Function context
 * @returns {{ base64: string, mimeType: string } | null}
 */
async function downloadMedia(mediaId, accessToken, context) {
  const url = `${WECHAT_API}/media/get?access_token=${accessToken}&media_id=${mediaId}`;
  
  context.log(`Downloading media: ${mediaId}`);
  
  try {
    const response = await fetch(url);
    
    // 检查 HTTP 状态
    if (!response.ok) {
      context.error(`media/get HTTP error: ${response.status} ${response.statusText}`);
      return null;
    }
    
    // 检查是否返回错误 JSON
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const error = await response.json();
      context.error(`media/get API error: ${error.errmsg} (${error.errcode})`);
      return null;
    }
    
    // 检查文件大小
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      context.error(`Media too large: ${contentLength} bytes (max: ${MAX_IMAGE_SIZE})`);
      return null;
    }
    
    // 获取图片数据
    const buffer = await response.arrayBuffer();
    
    // 二次检查实际大小
    if (buffer.byteLength > MAX_IMAGE_SIZE) {
      context.error(`Media too large after download: ${buffer.byteLength} bytes`);
      return null;
    }
    
    const base64 = Buffer.from(buffer).toString("base64");
    const mimeType = contentType.split(";")[0].trim() || "image/jpeg";
    
    const sizeKB = Math.round(buffer.byteLength / 1024);
    context.log(`Downloaded media: ${mimeType}, ${sizeKB}KB`);
    
    return { base64, mimeType };
  } catch (err) {
    context.error(`Failed to download media: ${err}`);
    return null;
  }
}

// ============================================================================
// Clawdbot 转发
// ============================================================================

// 重试配置
const WEBHOOK_MAX_RETRIES = 3;
const WEBHOOK_TIMEOUT_MS = 15000;

/**
 * 延迟函数
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 转发消息到 Clawdbot (带重试)
 */
async function forwardToClawdbot(message, config, context) {
  let imageBase64 = null;
  let imageMimeType = null;
  
  // 如果是图片消息，下载图片
  if (message.MsgType === "image" && message.MediaId) {
    try {
      const accessToken = await getAccessToken(config.corpId, config.secret, context);
      const media = await downloadMedia(message.MediaId, accessToken, context);
      if (media) {
        imageBase64 = media.base64;
        imageMimeType = media.mimeType;
      } else {
        context.warn("Failed to download image, continuing without image data");
      }
    } catch (err) {
      context.error(`Image download error: ${err}`);
      // 继续处理，只是不带图片
    }
  }
  
  const payload = {
    type: "wechat-work-message",
    fromUser: message.FromUserName,
    toUser: message.ToUserName,
    msgType: message.MsgType,
    content: message.Content || "",
    msgId: message.MsgId || "",
    agentId: message.AgentID,
    createTime: message.CreateTime,
    timestamp: Date.now(),
    event: message.Event,
    eventKey: message.EventKey,
    picUrl: message.PicUrl,
    mediaId: message.MediaId,
    // 图片数据 (仅当成功下载时)
    imageBase64: imageBase64,
    imageMimeType: imageMimeType,
  };

  const headers = { "Content-Type": "application/json" };
  if (config.webhookSecret) {
    headers["X-Webhook-Secret"] = config.webhookSecret;
  }

  // 带重试的 webhook 调用
  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    context.log(`Forwarding to Clawdbot (attempt ${attempt}/${WEBHOOK_MAX_RETRIES}): ${config.webhookUrl}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    
    try {
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      
      if (response.ok) {
        context.log(`Clawdbot webhook success: ${response.status}`);
        return true;
      }
      
      context.warn(`Webhook attempt ${attempt} failed: ${response.status} ${response.statusText}`);
    } catch (err) {
      clearTimeout(timeoutId);
      let errorMsg;
      if (err instanceof Error) {
        errorMsg = err.name === "AbortError" ? "timeout" : err.message;
      } else {
        errorMsg = String(err);
      }
      context.warn(`Webhook attempt ${attempt} error: ${errorMsg}`);
    }
    
    // 等待后重试 (递增延迟: 1s, 2s, 3s)
    if (attempt < WEBHOOK_MAX_RETRIES) {
      const waitMs = attempt * 1000;
      context.log(`Waiting ${waitMs}ms before retry...`);
      await delay(waitMs);
    }
  }
  
  context.error(`All ${WEBHOOK_MAX_RETRIES} webhook attempts failed`);
  return false;
}

// ============================================================================
// 应用主页 HTML
// ============================================================================

function getHomeHtml(config) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Nova 快捷指令</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 400px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      color: white;
      margin-bottom: 24px;
    }
    .header h1 {
      font-size: 28px;
      margin-bottom: 8px;
    }
    .header p {
      font-size: 14px;
      opacity: 0.9;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    .section-title {
      font-size: 12px;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 16px 0 12px 0;
    }
    .section-title:first-child {
      margin-top: 0;
    }
    .btn {
      display: flex;
      align-items: center;
      width: 100%;
      padding: 14px 16px;
      margin: 8px 0;
      font-size: 16px;
      border: none;
      border-radius: 12px;
      background: #f5f5f7;
      color: #333;
      cursor: pointer;
      transition: all 0.2s;
      text-align: left;
    }
    .btn:active {
      transform: scale(0.98);
      background: #e8e8ed;
    }
    .btn .icon {
      font-size: 24px;
      margin-right: 12px;
      width: 32px;
      text-align: center;
    }
    .btn .text {
      flex: 1;
    }
    .btn .text .title {
      font-weight: 500;
    }
    .btn .text .desc {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }
    .btn .arrow {
      color: #ccc;
      font-size: 18px;
    }
    .custom-input {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .custom-input input {
      flex: 1;
      padding: 12px;
      border: 2px solid #e8e8ed;
      border-radius: 10px;
      font-size: 16px;
      outline: none;
    }
    .custom-input input:focus {
      border-color: #667eea;
    }
    .custom-input button {
      padding: 12px 20px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      cursor: pointer;
    }
    .custom-input button:active {
      opacity: 0.8;
    }
    .hint {
      text-align: center;
      color: #888;
      font-size: 12px;
      margin-top: 16px;
      padding: 0 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🌟 Nova</h1>
      <p>点击按钮，跳转聊天并发送</p>
    </div>
    
    <div class="card">
      <div class="section-title">常用</div>
      
      <button class="btn" onclick="send('今天天气怎么样？')">
        <span class="icon">🌤️</span>
        <span class="text">
          <div class="title">查天气</div>
          <div class="desc">获取今日天气预报</div>
        </span>
        <span class="arrow">›</span>
      </button>
      
      <button class="btn" onclick="send('帮我看看日历，今天有什么安排？')">
        <span class="icon">📅</span>
        <span class="text">
          <div class="title">今日日程</div>
          <div class="desc">查看今天的日程安排</div>
        </span>
        <span class="arrow">›</span>
      </button>
      
      <button class="btn" onclick="send('查一下最近有没有重要邮件')">
        <span class="icon">📧</span>
        <span class="text">
          <div class="title">查邮件</div>
          <div class="desc">检查最近的重要邮件</div>
        </span>
        <span class="arrow">›</span>
      </button>

      <div class="section-title">效率</div>
      
      <button class="btn" onclick="send('帮我记一下：')">
        <span class="icon">📝</span>
        <span class="text">
          <div class="title">快速记事</div>
          <div class="desc">记录一条备忘</div>
        </span>
        <span class="arrow">›</span>
      </button>
      
      <button class="btn" onclick="send('我的待办事项有哪些？')">
        <span class="icon">✅</span>
        <span class="text">
          <div class="title">待办清单</div>
          <div class="desc">查看待办事项</div>
        </span>
        <span class="arrow">›</span>
      </button>

      <div class="section-title">自定义</div>
      
      <div class="custom-input">
        <input type="text" id="customMsg" placeholder="输入消息..." />
        <button onclick="sendCustom()">发送</button>
      </div>

      <p class="hint">点击后跳转到聊天窗口，消息已预填，再点发送即可</p>
    </div>
  </div>

  <script>
    // 方案 B: 使用 URL Scheme 跳转到聊天窗口
    function send(text) {
      // wxwork://message 会打开应用聊天并预填消息
      window.location.href = 'wxwork://message?content=' + encodeURIComponent(text);
    }

    // 发送自定义消息
    function sendCustom() {
      const input = document.getElementById('customMsg');
      const text = input.value.trim();
      if (text) {
        send(text);
        input.value = '';
      }
    }

    // Enter 键发送
    document.getElementById('customMsg').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        sendCustom();
      }
    });
  </script>
</body>
</html>`;
}

// ============================================================================
// HTTP Handlers
// ============================================================================

/**
 * /api/wechat - 消息回调处理
 */
async function wechatCallback(request, context) {
  context.log("WeChat callback: " + request.method + " " + request.url);

  const config = getConfig();
  
  if (!config.token || !config.encodingAESKey || !config.corpId) {
    context.error("Missing WeChat config");
    return { status: 500, body: "Configuration error" };
  }

  const crypt = new WxBizMsgCrypt({
    token: config.token,
    encodingAESKey: config.encodingAESKey,
    corpId: config.corpId,
  });

  const msgSignature = request.query.get("msg_signature") || "";
  const timestamp = request.query.get("timestamp") || "";
  const nonce = request.query.get("nonce") || "";
  const echostr = request.query.get("echostr") || "";

  // GET: URL 验证
  if (request.method === "GET") {
    context.log("URL verification request");
    
    if (!echostr) {
      return { status: 400, body: "Missing echostr" };
    }

    const decrypted = crypt.verifyUrl(msgSignature, timestamp, nonce, echostr);
    if (decrypted === null) {
      context.error("URL verification failed");
      return { status: 403, body: "Verification failed" };
    }

    context.log("URL verification success");
    return { status: 200, body: decrypted };
  }

  // POST: 消息回调
  if (request.method === "POST") {
    const body = await request.text();
    context.log("Received message body length: " + body.length);

    const encryptMatch = /<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/.exec(body);
    if (!encryptMatch) {
      context.error("No encrypted content found");
      return { status: 400, body: "Invalid request" };
    }

    const encrypted = encryptMatch[1];

    if (!crypt.verifySignature(msgSignature, timestamp, nonce, encrypted)) {
      context.error("Signature verification failed");
      return { status: 403, body: "Signature verification failed" };
    }

    const decrypted = crypt.decrypt(encrypted);
    if (!decrypted) {
      context.error("Decryption failed");
      return { status: 400, body: "Decryption failed" };
    }

    const message = parseXml(decrypted);
    if (!message || !message.FromUserName) {
      context.error("Invalid message format");
      return { status: 400, body: "Invalid message format" };
    }

    context.log("Message from " + message.FromUserName + ": " + message.MsgType);

    await forwardToClawdbot(message, config, context);

    return { status: 200, body: "success" };
  }

  return { status: 405, body: "Method not allowed" };
}

/**
 * /api/jssdk-config - JS-SDK 签名配置
 */
async function jssdkConfig(request, context) {
  context.log("JSSDK config request");

  const config = getConfig();
  
  if (!config.corpId || !config.secret) {
    return {
      status: 500,
      jsonBody: { error: "Missing WECHAT_CORP_ID or WECHAT_SECRET" }
    };
  }

  const url = request.query.get("url");
  if (!url) {
    return {
      status: 400,
      jsonBody: { error: "Missing url parameter" }
    };
  }

  try {
    // 获取 access_token
    const accessToken = await getAccessToken(config.corpId, config.secret, context);
    
    // 获取 jsapi_ticket
    const ticket = await getJsapiTicket(accessToken, context);
    
    // 生成签名
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = generateNonceStr();
    const signature = generateJssdkSignature(ticket, nonceStr, timestamp, decodeURIComponent(url));

    context.log("JSSDK config generated for: " + url);

    return {
      status: 200,
      jsonBody: {
        corpId: config.corpId,
        agentId: config.agentId,
        timestamp,
        nonceStr,
        signature,
      }
    };
  } catch (err) {
    context.error("JSSDK config error: " + err);
    return {
      status: 500,
      jsonBody: { error: err.message }
    };
  }
}

/**
 * /api/home - 应用主页
 */
async function homePage(request, context) {
  context.log("Home page request");

  const config = getConfig();

  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    },
    body: getHomeHtml(config)
  };
}

// ============================================================================
// 注册 Azure Functions
// ============================================================================

app.http("wechat", {
  route: "api/wechat",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: wechatCallback,
});

app.http("jssdk-config", {
  route: "api/jssdk-config",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: jssdkConfig,
});

app.http("home", {
  route: "api/home",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: homePage,
});

// 企业微信域名验证文件 (根目录)
app.http("wechat-verify", {
  route: "WW_verify_RBDRoelCfCCaKXU1.txt",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    return { status: 200, body: "RBDRoelCfCCaKXU1" };
  },
});
