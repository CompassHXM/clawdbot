import type { IncomingMessage, ServerResponse } from "node:http";

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedWechatWorkAccount, WechatWorkConfig } from "./channel.js";
import { getWechatRuntime } from "./runtime.js";
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

  const body = await readJsonBody(req, 1024 * 1024);
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
    `[wechat] webhook accepted sender=${message.fromUser} content=${message.content.slice(0, 50)}...`,
  );
  return true;
}

async function processMessage(
  message: WechatInboundMessage,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;

  if (message.msgType !== "text") {
    runtime.log?.(`[wechat] skipping non-text message type=${message.msgType}`);
    return;
  }

  const text = message.content.trim();
  if (!text) {
    runtime.log?.("[wechat] skipping empty message");
    return;
  }

  runtime.log?.(`[wechat] processing message from=${message.fromUser} text=${text}`);

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

  // Dispatch reply using the standard pipeline
  const section = config?.channels?.wechat as WechatWorkConfig | undefined;
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        if (!section?.corpId || !section?.agentId || !section?.secret) {
          runtime.error?.("[wechat] cannot send reply: missing corpId/agentId/secret");
          return;
        }
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
        runtime.error?.(`[wechat] ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

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
