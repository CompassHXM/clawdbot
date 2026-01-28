/**
 * WeChat Work Relay - Azure Function
 * 
 * 接收企业微信的回调消息，解密后转发到 Clawdbot webhook
 * 
 * 环境变量:
 * - WECHAT_TOKEN: 企业微信后台配置的 Token
 * - WECHAT_ENCODING_AES_KEY: 企业微信后台配置的 EncodingAESKey (43位)
 * - WECHAT_CORP_ID: 企业ID (corpid)
 * - CLAWDBOT_WEBHOOK_URL: Clawdbot webhook 地址
 * - CLAWDBOT_WEBHOOK_SECRET: (可选) Webhook 密钥
 */

const { app } = require("@azure/functions");
const crypto = require("crypto");

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
   * @param {string} signature - 签名
   * @param {string} timestamp - 时间戳
   * @param {string} nonce - 随机数
   * @param {string} echostr - 加密字符串
   * @returns {boolean}
   */
  verifySignature(signature, timestamp, nonce, echostr) {
    const arr = [this.token, timestamp, nonce, echostr].sort();
    const str = arr.join("");
    const hash = crypto.createHash("sha1").update(str).digest("hex");
    return hash === signature;
  }

  /**
   * 验证 URL 回调（首次配置时的验证请求）
   * @param {string} msgSignature - 消息签名
   * @param {string} timestamp - 时间戳
   * @param {string} nonce - 随机数
   * @param {string} echostr - 加密的 echostr
   * @returns {string|null} 解密后的 echostr，验证失败返回 null
   */
  verifyUrl(msgSignature, timestamp, nonce, echostr) {
    if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
      return null;
    }
    return this.decrypt(echostr);
  }

  /**
   * 解密消息
   * @param {string} encrypted - Base64 编码的加密消息
   * @returns {string|null} 解密后的明文，失败返回 null
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

      // 解析结构：前 16 字节是随机字符串，接下来 4 字节是消息长度（网络字节序），
      // 然后是消息内容，最后是 corpId
      const msgLen = decrypted.readUInt32BE(16);
      const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
      const receivedCorpId = decrypted.subarray(20 + msgLen).toString("utf8");

      // 验证 corpId
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

/**
 * 解析企业微信消息 XML
 * @param {string} xml - XML 字符串
 * @returns {Object} 解析后的消息对象
 */
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

/**
 * 从环境变量获取配置
 * @returns {Object} 配置对象
 * @throws {Error} 配置缺失时抛出错误
 */
function getConfig() {
  const token = process.env.WECHAT_TOKEN;
  const encodingAESKey = process.env.WECHAT_ENCODING_AES_KEY;
  const corpId = process.env.WECHAT_CORP_ID;
  const webhookUrl = process.env.CLAWDBOT_WEBHOOK_URL;
  const webhookSecret = process.env.CLAWDBOT_WEBHOOK_SECRET;

  if (!token || !encodingAESKey || !corpId) {
    throw new Error("Missing WeChat config: WECHAT_TOKEN, WECHAT_ENCODING_AES_KEY, WECHAT_CORP_ID");
  }
  if (!webhookUrl) {
    throw new Error("Missing CLAWDBOT_WEBHOOK_URL");
  }

  return { token, encodingAESKey, corpId, webhookUrl, webhookSecret };
}

// ============================================================================
// Clawdbot 转发
// ============================================================================

/**
 * 转发消息到 Clawdbot webhook
 * @param {Object} message - 解析后的消息对象
 * @param {Object} config - 配置对象
 * @param {Object} context - Azure Function 上下文
 * @returns {Promise<boolean>} 是否成功
 */
async function forwardToClawdbot(message, config, context) {
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
    // 事件类型消息的额外字段
    event: message.Event,
    eventKey: message.EventKey,
    // 图片消息的额外字段
    picUrl: message.PicUrl,
    mediaId: message.MediaId,
  };

  const headers = { "Content-Type": "application/json" };
  if (config.webhookSecret) {
    headers["X-Webhook-Secret"] = config.webhookSecret;
  }

  try {
    context.log("Forwarding to Clawdbot: " + config.webhookUrl);
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      context.error("Clawdbot webhook failed: " + response.status + " " + response.statusText);
      return false;
    }

    context.log("Clawdbot webhook success: " + response.status);
    return true;
  } catch (err) {
    context.error("Clawdbot webhook error: " + err);
    return false;
  }
}

// ============================================================================
// 主处理函数
// ============================================================================

/**
 * Azure Function 处理函数
 * @param {Object} request - HTTP 请求
 * @param {Object} context - 函数上下文
 * @returns {Promise<Object>} HTTP 响应
 */
async function wechatCallback(request, context) {
  context.log("WeChat callback: " + request.method + " " + request.url);

  // 获取配置
  let config;
  try {
    config = getConfig();
  } catch (err) {
    context.error("Config error: " + err);
    return { status: 500, body: "Configuration error" };
  }

  // 初始化加密工具
  const crypt = new WxBizMsgCrypt({
    token: config.token,
    encodingAESKey: config.encodingAESKey,
    corpId: config.corpId,
  });

  // 获取 URL 参数
  const msgSignature = request.query.get("msg_signature") || "";
  const timestamp = request.query.get("timestamp") || "";
  const nonce = request.query.get("nonce") || "";
  const echostr = request.query.get("echostr") || "";

  // GET 请求: URL 验证（企业微信首次配置回调时的验证）
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

    context.log("URL verification success: " + decrypted);
    return { status: 200, body: decrypted };
  }

  // POST 请求: 消息回调
  if (request.method === "POST") {
    const body = await request.text();
    context.log("Received message body length: " + body.length);

    // 从 XML 中提取加密消息
    const encryptMatch = /<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/.exec(body);
    if (!encryptMatch) {
      context.error("No encrypted content found in body");
      return { status: 400, body: "Invalid request: no encrypted content" };
    }

    const encrypted = encryptMatch[1];

    // 验证签名
    if (!crypt.verifySignature(msgSignature, timestamp, nonce, encrypted)) {
      context.error("Message signature verification failed");
      return { status: 403, body: "Signature verification failed" };
    }

    // 解密消息
    const decrypted = crypt.decrypt(encrypted);
    if (!decrypted) {
      context.error("Message decryption failed");
      return { status: 400, body: "Decryption failed" };
    }

    context.log("Decrypted message: " + decrypted.substring(0, 200) + "...");

    // 解析 XML
    const message = parseXml(decrypted);
    if (!message || !message.FromUserName) {
      context.error("XML parse failed or missing FromUserName");
      return { status: 400, body: "Invalid message format" };
    }

    context.log("Parsed message: type=" + message.MsgType + ", from=" + message.FromUserName);

    // 转发到 Clawdbot
    await forwardToClawdbot(message, config, context);

    // 企业微信要求返回 "success" 或空字符串表示成功
    return { status: 200, body: "success" };
  }

  return { status: 405, body: "Method not allowed" };
}

// ============================================================================
// 注册 Azure Function
// ============================================================================

app.http("wechat", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: wechatCallback,
});
