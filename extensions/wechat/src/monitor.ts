import type { IncomingMessage, ServerResponse } from "node:http";

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedWechatWorkAccount, WechatWorkConfig } from "./channel.js";
import { getWechatRuntime } from "./runtime.js";
import { loadSpeechCredentials, transcribeVoice } from "./speech.js";
import { recordUser, syncUsersMd } from "./user-directory.js";

export type WechatRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WechatMonitorOptions = {
  account: ResolvedWechatWorkAccount;
  config: OpenClawConfig;
  runtime: WechatRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookPath?: string;
  webhookSecret?: string;
};

const DEFAULT_WEBHOOK_PATH = "/wechat-webhook";

type WebhookTarget = {
  account: ResolvedWechatWorkAccount;
  config: OpenClawConfig;
  runtime: WechatRuntimeEnv;
  core: ReturnType<typeof getWechatRuntime>;
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

// 消息去重缓存 (msgId -> timestamp)
// 防止企业微信重试或多 target 导致的重复处理
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const DEDUPE_MAX_SIZE = 1000;
const processedMessages = new Map<string, number>();

function isMessageProcessed(msgId: string): boolean {
  if (!msgId) return false;
  const now = Date.now();

  // 清理过期条目
  if (processedMessages.size > DEDUPE_MAX_SIZE / 2) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUPE_TTL_MS) {
        processedMessages.delete(id);
      }
    }
  }

  if (processedMessages.has(msgId)) {
    return true;
  }

  processedMessages.set(msgId, now);
  return false;
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

export function registerWechatWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

type WechatInboundMessage = {
  fromUser: string;
  toUser: string;
  msgType: string;
  content: string;
  msgId: string;
  agentId?: string;
  createTime?: string;
  timestamp?: number;
  // 图片相关字段
  picUrl?: string;
  mediaId?: string;
  imageBase64?: string;
  imageMimeType?: string;
  // 语音相关字段
  voiceBase64?: string;
  voiceFormat?: string;
};

function normalizeWechatMessage(payload: Record<string, unknown>): WechatInboundMessage | null {
  const type = readString(payload, "type");
  if (type !== "wechat-work-message") return null;

  const fromUser = readString(payload, "fromUser");
  const msgType = readString(payload, "msgType");
  const content = readString(payload, "content");

  if (!fromUser || !msgType) return null;

  return {
    fromUser,
    toUser: readString(payload, "toUser") ?? "",
    msgType,
    content: content ?? "",
    msgId: readString(payload, "msgId") ?? "",
    agentId: readString(payload, "agentId"),
    createTime: readString(payload, "createTime"),
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : undefined,
    // 图片相关字段
    picUrl: readString(payload, "picUrl"),
    mediaId: readString(payload, "mediaId"),
    imageBase64: readString(payload, "imageBase64"),
    imageMimeType: readString(payload, "imageMimeType"),
    // 语音相关字段
    voiceBase64: readString(payload, "voiceBase64"),
    voiceFormat: readString(payload, "voiceFormat"),
  };
}

export async function handleWechatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 10 * 1024 * 1024); // 10MB to accommodate base64 images
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    console.warn(`[wechat] webhook rejected: ${body.error ?? "invalid payload"}`);
    return true;
  }

  const payload = asRecord(body.value) ?? {};

  // Verify webhook secret if configured
  const matching = targets.filter((target) => {
    const secret = target.secret?.trim();
    if (!secret) return true;
    const headerSecret = req.headers["x-webhook-secret"];
    const secretValue = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;
    return secretValue === secret;
  });

  if (matching.length === 0) {
    res.statusCode = 401;
    res.end("unauthorized");
    console.warn("[wechat] webhook rejected: unauthorized");
    return true;
  }

  const message = normalizeWechatMessage(payload);
  if (!message) {
    res.statusCode = 400;
    res.end("invalid payload");
    console.warn("[wechat] webhook rejected: unable to parse message payload");
    return true;
  }

  // 消息去重：检查 msgId 是否已处理
  if (isMessageProcessed(message.msgId)) {
    res.statusCode = 200;
    res.end("ok");
    console.log(`[wechat] webhook skipped: duplicate msgId=${message.msgId}`);
    return true;
  }

  // 只处理第一个匹配的 target（避免多 target 重复处理）
  const target = matching[0];
  target.statusSink?.({ lastInboundAt: Date.now() });
  processMessage(message, target).catch((err) => {
    target.runtime.error?.(
      `[${target.account.accountId}] WeChat webhook failed: ${String(err)}`,
    );
  });

  res.statusCode = 200;
  res.end("ok");
  
  target.runtime.log?.(
    `[wechat] webhook accepted sender=${message.fromUser} type=${message.msgType} content=${message.content?.slice(0, 50) || "(empty)"}`,
  );
  // 语音消息额外日志
  if (message.msgType === "voice") {
    target.runtime.log?.(
      `[wechat] voice message details: voiceBase64=${message.voiceBase64 ? `${Math.round(message.voiceBase64.length * 0.75 / 1024)}KB` : "missing"} format=${message.voiceFormat || "unknown"}`,
    );
  }
  return true;
}

async function processMessage(
  message: WechatInboundMessage,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;

  // 支持的消息类型
  const supportedTypes = ["text", "image", "voice"];
  if (!supportedTypes.includes(message.msgType)) {
    runtime.log?.(`[wechat] skipping unsupported message type=${message.msgType}`);
    return;
  }

  // 构建消息文本和图片
  let text = message.content?.trim() || "";
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  if (message.msgType === "voice") {
    runtime.log?.(`[wechat] voice message received: voiceBase64=${message.voiceBase64 ? "present" : "missing"}, format=${message.voiceFormat ?? "unknown"}`);

    if (message.voiceBase64) {
      runtime.log?.(`[wechat] voice message: format=${message.voiceFormat ?? "unknown"}, size=${Math.round(message.voiceBase64.length * 0.75 / 1024)}KB`);

      // 加载 Azure Speech 凭证
      const credentials = loadSpeechCredentials();
      if (!credentials) {
        runtime.log?.("[wechat] Azure Speech credentials not configured");
        text = "[语音] (无法转写：未配置语音识别服务)";
      } else {
        runtime.log?.(`[wechat] credentials loaded, region=${credentials.region}`);
        // 转写语音
        const audioBuffer = Buffer.from(message.voiceBase64, "base64");
        runtime.log?.(`[wechat] audio buffer created, size=${audioBuffer.length} bytes`);
        
        try {
          const result = await transcribeVoice({
            speechKey: credentials.key,
            speechRegion: credentials.region,
            audioBuffer,
            audioFormat: message.voiceFormat as "amr" | "wav" | undefined ?? "amr",
            candidateLanguages: ["zh-CN", "en-US"],
          });

          runtime.log?.(`[wechat] transcription result: ok=${result.ok}, ${result.ok ? `text="${result.text}"` : `error="${result.error}"`}`);

          if (result.ok) {
            if (result.text && result.text.trim()) {
              text = `[语音] ${result.text}`;
              runtime.log?.(`[wechat] voice transcription success: lang=${result.language}, confidence=${result.confidence?.toFixed(2)}, text="${result.text.slice(0, 50)}..."`);
            } else {
              text = "[语音] (转写结果为空)";
              runtime.log?.(`[wechat] voice transcription returned empty text: lang=${result.language}, confidence=${result.confidence?.toFixed(2)}`);
            }
          } else {
            const errorMsg = result.error;
            runtime.log?.(`[wechat] voice transcription failed: ${errorMsg}`);
            text = `[语音] (转写失败: ${errorMsg})`;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          runtime.error?.(`[wechat] transcription threw error: ${errMsg}`);
          text = `[语音] (转写异常: ${errMsg})`;
        }
      }
    } else {
      runtime.log?.("[wechat] voice message missing base64 data");
      text = "[语音] (数据不可用)";
    }
  } else if (message.msgType === "image") {
    if (message.imageBase64 && message.imageMimeType) {
      images.push({
        type: "image",
        data: message.imageBase64,
        mimeType: message.imageMimeType,
      });
      // 图片消息如果没有文字，使用占位符
      if (!text) {
        text = "[图片]";
      }
      runtime.log?.(`[wechat] image message: mimeType=${message.imageMimeType}, size=${Math.round(message.imageBase64.length * 0.75 / 1024)}KB`);
    } else {
      // 图片数据缺失时优雅降级，保留消息而不是丢弃
      const metaParts: string[] = [];
      if (message.picUrl) {
        metaParts.push(`picUrl=${message.picUrl}`);
      }
      if (message.mediaId) {
        metaParts.push(`mediaId=${message.mediaId}`);
      }
      const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
      runtime.error?.(`[wechat] image message missing base64 data, continuing without image data${metaSuffix}`);
      // 没有图片数据时，使用占位符文本保留消息
      if (!text) {
        text = metaParts.length > 0
          ? `[图片不可用] ${metaParts.join(" ")}`
          : "[图片不可用]";
      }
    }
  }

  if (!text && images.length === 0) {
    runtime.log?.("[wechat] skipping empty message");
    return;
  }

  runtime.log?.(`[wechat] processing message from=${message.fromUser} type=${message.msgType} text="${text.slice(0, 50)}..."`);

  // 记录用户到目录
  try {
    recordUser({ userId: message.fromUser });
    syncUsersMd(); // 同步到 users.md 文件
    runtime.log?.(`[wechat] recorded user: ${message.fromUser}`);
  } catch (err) {
    runtime.error?.(`[wechat] failed to record user: ${err}`);
  }

  // Check DM policy
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  runtime.log?.(`[wechat] dmPolicy=${dmPolicy}`);
  const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore("wechat")
    .catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  if (dmPolicy === "disabled") {
    runtime.log?.(`[wechat] blocked DM from ${message.fromUser} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    const isAllowed = effectiveAllowFrom.some((entry) => {
      const lower = entry.toLowerCase();
      const senderLower = message.fromUser.toLowerCase();
      return lower === senderLower || lower === "*";
    });

    if (!isAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "wechat",
          id: message.fromUser,
          meta: {},
        });
        runtime.log?.(`[wechat] pairing request sender=${message.fromUser} created=${created}`);

        if (created) {
          // Send pairing response
          const section = config?.channels?.wechat as WechatWorkConfig | undefined;
          if (section?.corpId && section?.agentId && section?.secret) {
            try {
              const { sendWorkWechatMessage } = await import("./channel.js");
              await sendWorkWechatMessage({
                corpId: section.corpId,
                secret: section.secret,
                agentId: section.agentId,
                toUser: message.fromUser,
                content: core.channel.pairing.buildPairingReply({
                  channel: "wechat",
                  idLine: `Your WeChat Work user id: ${message.fromUser}`,
                  code,
                }),
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(`[wechat] pairing reply failed: ${String(err)}`);
            }
          }
        }
      } else {
        runtime.log?.(
          `[wechat] blocked unauthorized sender ${message.fromUser} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  // Route to agent
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wechat",
    accountId: account.accountId,
    peer: {
      kind: "dm",
      id: message.fromUser,
    },
  });

  // Build envelope for agent
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeChat",
    from: message.fromUser,
    timestamp: message.timestamp ?? Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  const ctxPayload = {
    Body: body,
    BodyForAgent: body,
    RawBody: text,
    CommandBody: text,
    BodyForCommands: text,
    From: `wechat:${message.fromUser}`,
    To: `wechat:${message.fromUser}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: message.fromUser,
    SenderId: message.fromUser,
    Provider: "wechat",
    Surface: "wechat",
    MessageSid: message.msgId,
    Timestamp: message.timestamp ?? Date.now(),
    OriginatingChannel: "wechat",
    OriginatingTo: `wechat:${message.fromUser}`,
    WasMentioned: true,
    CommandAuthorized: true,
  };

  runtime.log?.(`[wechat] dispatching to session=${route.sessionKey} agent=${route.agentId}`);

  // Dispatch reply using the standard pipeline
  const section = config?.channels?.wechat as WechatWorkConfig | undefined;
  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        deliver: async (payload) => {
          runtime.log?.(`[wechat] deliver called: text="${(payload.text ?? "").slice(0, 100)}..." mediaUrl=${payload.mediaUrl ?? "none"}`);
          if (!section?.corpId || !section?.agentId || !section?.secret) {
            runtime.error?.("[wechat] cannot send reply: missing corpId/agentId/secret");
            return;
          }

          // 如果有 mediaUrl（TTS 音频），使用 sendMedia 发送语音
          if (payload.mediaUrl) {
            const { sendMedia } = await import("./channel.js");
            const result = await sendMedia({
              corpId: section.corpId,
              secret: section.secret,
              agentId: section.agentId,
              toUser: message.fromUser,
              mediaUrl: payload.mediaUrl,
              text: payload.text,
            });
            runtime.log?.(`[wechat] sendMedia result: ok=${result.ok} error=${result.error ?? "none"}`);
            if (result.ok) {
              statusSink?.({ lastOutboundAt: Date.now() });
              return;
            }
            // 如果语音发送失败，fallback 到文本
            runtime.log?.(`[wechat] voice send failed, falling back to text`);
          }

          // 发送文本消息
          const textLimit = 2048;
          const chunks = core.channel.text.chunkMarkdownText(payload.text ?? "", textLimit);
          if (!chunks.length && payload.text) chunks.push(payload.text);
          
          for (const chunk of chunks) {
            const { sendWorkWechatMessage } = await import("./channel.js");
            await sendWorkWechatMessage({
              corpId: section.corpId,
              secret: section.secret,
              agentId: section.agentId,
              toUser: message.fromUser,
              content: chunk,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        },
        onReplyStart: async () => {
          // WeChat doesn't support typing indicators
        },
        onIdle: async () => {
          // WeChat doesn't support typing indicators
        },
        onError: (err, info) => {
          runtime.log?.(`[wechat] ${info.kind} reply error: ${String(err)}`);
          runtime.error?.(`[wechat] ${info.kind} reply failed: ${String(err)}`);
        },
      },
      // 传递图片给 Agent
      replyOptions: images.length > 0 ? { images } : undefined,
    });
    runtime.log?.(`[wechat] dispatch completed for session ${route.sessionKey}`);
  } catch (err) {
    runtime.log?.(`[wechat] dispatch threw error: ${err instanceof Error ? err.message : String(err)}`);
  }

  runtime.log?.(`[wechat] message dispatched to session ${route.sessionKey}`);
}

export function startWechatMonitor(options: WechatMonitorOptions): () => void {
  const { account, config, runtime, statusSink, webhookPath, webhookSecret } = options;
  const core = getWechatRuntime();
  const path = webhookPath ?? account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;

  runtime.log?.(`[${account.accountId}] Starting WeChat webhook monitor on path: ${path}`);

  const unregister = registerWechatWebhookTarget({
    account,
    config,
    runtime,
    core,
    path,
    secret: webhookSecret ?? account.config.webhookSecret,
    statusSink,
  });

  return unregister;
}
