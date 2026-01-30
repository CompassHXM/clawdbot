import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { z } from "zod";

import { getWechatRuntime } from "./runtime.js";
import {
  listUsers,
  resolveUserId,
  type WechatUserEntry,
} from "./user-directory.js";

// 企业微信 API 基础 URL
const WORK_WECHAT_API = "https://qyapi.weixin.qq.com/cgi-bin";

// Config schema for WeChat Work channel
export const WechatWorkConfigSchema = z.object({
  enabled: z.boolean().optional(),
  corpId: z.string().optional(),
  agentId: z.string().optional(),
  secret: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "closed"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  webhookPath: z.string().optional(),
  webhookSecret: z.string().optional(),
});

export type WechatWorkConfig = z.infer<typeof WechatWorkConfigSchema>;

export type ResolvedWechatWorkAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: WechatWorkConfig;
  corpId?: string;
  agentId?: string;
  secret?: string;
};

// Token 缓存
let accessTokenCache: { token: string; expiresAt: number } | null = null;

/**
 * 获取企业微信 access_token
 */
export async function getAccessToken(corpId: string, secret: string): Promise<string> {
  // 检查缓存
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60000) {
    return accessTokenCache.token;
  }

  const url = `${WORK_WECHAT_API}/gettoken?corpid=${corpId}&corpsecret=${secret}`;
  const response = await fetch(url);
  const data = (await response.json()) as {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
    expires_in?: number;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat Work API error: ${data.errmsg} (code: ${data.errcode})`);
  }

  if (!data.access_token) {
    throw new Error("Failed to get access token");
  }

  // 缓存 token
  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };

  return data.access_token;
}

/**
 * 发送企业微信消息
 */
export async function sendWorkWechatMessage(params: {
  corpId: string;
  secret: string;
  agentId: string;
  toUser: string; // 用户ID，多个用 | 分隔，@all 表示全部
  content: string;
  msgType?: "text" | "markdown";
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { corpId, secret, agentId, toUser, content, msgType = "text" } = params;

  try {
    const token = await getAccessToken(corpId, secret);
    const url = `${WORK_WECHAT_API}/message/send?access_token=${token}`;

    const body =
      msgType === "markdown"
        ? {
            touser: toUser,
            msgtype: "markdown",
            agentid: Number.parseInt(agentId, 10),
            markdown: { content },
          }
        : {
            touser: toUser,
            msgtype: "text",
            agentid: Number.parseInt(agentId, 10),
            text: { content },
          };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      msgid?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      return { ok: false, error: `${data.errmsg} (code: ${data.errcode})` };
    }

    return { ok: true, messageId: data.msgid };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function listWechatWorkAccountIds(cfg: OpenClawConfig): string[] {
  const section = cfg.channels?.wechat;
  if (!section) return [];
  return [DEFAULT_ACCOUNT_ID];
}

function resolveWechatWorkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWechatWorkAccount {
  const { cfg, accountId } = params;
  const resolvedAccountId = normalizeAccountId(accountId);
  const section = cfg.channels?.wechat as WechatWorkConfig | undefined;

  return {
    accountId: resolvedAccountId,
    enabled: section?.enabled ?? false,
    config: section ?? {},
    corpId: section?.corpId,
    agentId: section?.agentId,
    secret: section?.secret,
  };
}

/**
 * 检查是否像 WeChat Work 目标 ID
 * - 纯字母数字（企业微信 UserID 通常是这种格式）
 * - wechat:userId 格式
 */
function looksLikeWechatTargetId(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;

  // wechat:xxx 格式
  if (/^wechat:/i.test(trimmed)) return true;

  // 企业微信 UserID 通常是字母数字组合，可能包含下划线
  // 支持中文用户名作为查找目标
  return /^[\w\u4e00-\u9fa5-]+$/i.test(trimmed);
}

/**
 * 规范化 WeChat 消息目标
 */
function normalizeWechatMessagingTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  // 移除 wechat: 前缀
  const cleaned = trimmed.replace(/^wechat:/i, "").trim();
  if (!cleaned) return null;

  return cleaned;
}

/**
 * 用户目录条目转换为 ChannelDirectoryEntry
 */
function userEntryToDirectoryEntry(entry: WechatUserEntry): {
  kind: "user";
  id: string;
  name?: string;
  raw?: Record<string, unknown>;
} {
  return {
    kind: "user",
    id: entry.userId,
    name: entry.alias ?? entry.name,
    raw: {
      userId: entry.userId,
      alias: entry.alias,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      messageCount: entry.messageCount,
    },
  };
}

export const wechatPlugin: ChannelPlugin<ResolvedWechatWorkAccount> = {
  id: "wechat",
  meta: {
    id: "wechat",
    label: "WeChat Work",
    selectionLabel: "WeChat Work (企业微信)",
    docsPath: "/channels/wechat",
    blurb: "Connect your WeChat Work (企业微信) account via official API.",
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wechat"] },
  configSchema: buildChannelConfigSchema(WechatWorkConfigSchema),
  config: {
    listAccountIds: (cfg) => listWechatWorkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWechatWorkAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    // Webhook 接收模式不需要完整配置也能工作
    isConfigured: (account) => account.enabled ?? true,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.corpId && account.agentId && account.secret),
    }),
    resolveAllowFrom: ({ cfg }) => {
      const section = cfg.channels?.wechat as WechatWorkConfig | undefined;
      return section?.allowFrom ?? [];
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountConfig: ({ cfg }) => {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wechat: {
            ...cfg.channels?.wechat,
            enabled: true,
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeWechatMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeWechatTargetId,
      hint: "<userId|userName|wechat:userId>",
    },
  },
  directory: {
    self: async () => null, // WeChat Work 没有 "self" 概念
    listPeers: async (params) => {
      // 从用户目录获取已知用户
      const users = listUsers({
        query: params.query ?? undefined,
        limit: params.limit ?? undefined,
      });
      return users.map(userEntryToDirectoryEntry);
    },
    listGroups: async () => {
      // WeChat Work 当前只支持私聊
      return [];
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 2048, // 企业微信文本消息限制
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const hasWildcard = allowListRaw.includes("*");
      const allowList = allowListRaw.filter((entry) => entry !== "*");

      if (trimmed) {
        // 尝试解析目标 userId
        const resolved = resolveUserId(trimmed);
        if (resolved) {
          // 对于 explicit 模式，直接返回解析后的 userId
          if (mode === "explicit") {
            return { ok: true, to: resolved };
          }
          // 对于 implicit/heartbeat 模式，检查是否在 allowFrom 中
          if (hasWildcard || allowList.length === 0) {
            return { ok: true, to: resolved };
          }
          const resolvedLower = resolved.toLowerCase();
          if (allowList.some((entry) => entry.toLowerCase() === resolvedLower)) {
            return { ok: true, to: resolved };
          }
          // 不在 allowList 中，fallback 到第一个允许的用户
          if (allowList.length > 0) {
            const fallbackResolved = resolveUserId(allowList[0]);
            if (fallbackResolved) {
              return { ok: true, to: fallbackResolved };
            }
          }
          return { ok: true, to: resolved };
        }
        // 无法解析，但仍然返回原始值（可能是新用户）
        return { ok: true, to: trimmed };
      }

      // 没有提供 target，尝试从 allowList 获取
      if (allowList.length > 0) {
        const resolved = resolveUserId(allowList[0]);
        if (resolved) {
          return { ok: true, to: resolved };
        }
        return { ok: true, to: allowList[0] };
      }

      // 尝试从用户目录获取最近活跃的用户
      const recentUsers = listUsers({ limit: 1 });
      if (recentUsers.length > 0) {
        return { ok: true, to: recentUsers[0].userId };
      }

      return {
        ok: false,
        error: new Error(
          "WeChat Work target required: provide userId, userName, or configure allowFrom",
        ),
      };
    },
    sendText: async ({ to, text, cfg }) => {
      const section = cfg?.channels?.wechat as WechatWorkConfig | undefined;
      const corpId = section?.corpId;
      const agentId = section?.agentId;
      const secret = section?.secret;

      if (!corpId || !agentId || !secret) {
        return {
          channel: "wechat",
          ok: false,
          error: "WeChat Work not configured (missing corpId/agentId/secret)",
        };
      }

      const result = await sendWorkWechatMessage({
        corpId,
        secret,
        agentId,
        toUser: to,
        content: text,
      });

      return { channel: "wechat", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, cfg }) => {
      // TODO: 实现媒体发送（需要先上传到企业微信获取 media_id）
      // 暂时用文本方式发送媒体链接
      const section = cfg?.channels?.wechat as WechatWorkConfig | undefined;
      const corpId = section?.corpId;
      const agentId = section?.agentId;
      const secret = section?.secret;

      if (!corpId || !agentId || !secret) {
        return {
          channel: "wechat",
          ok: false,
          error: "WeChat Work not configured",
        };
      }

      const content = text ? `${text}\n${mediaUrl}` : mediaUrl ?? "";
      const result = await sendWorkWechatMessage({
        corpId,
        secret,
        agentId,
        toUser: to,
        content,
      });

      return { channel: "wechat", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    probeAccount: async ({ account }) => {
      if (!account.corpId || !account.secret) {
        return { ok: false, error: "Not configured" };
      }
      try {
        const token = await getAccessToken(account.corpId, account.secret);
        return { ok: true, hasToken: Boolean(token) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.corpId && account.agentId && account.secret),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg, log, setStatus, getStatus, abortSignal } = ctx;
      log?.info(`[${account.accountId}] Starting WeChat Work`);

      // 测试连接
      if (account.corpId && account.secret) {
        try {
          await getAccessToken(account.corpId, account.secret);
          log?.info(`[${account.accountId}] WeChat Work connected successfully`);
        } catch (err) {
          log?.error(`[${account.accountId}] Failed to connect: ${err}`);
        }
      }

      // 启动 webhook monitor
      const { startWechatMonitor } = await import("./monitor.js");
      const unregister = startWechatMonitor({
        account,
        config: cfg,
        runtime: {
          log: (msg) => log?.info(msg),
          error: (msg) => log?.error(msg),
        },
        abortSignal,
        statusSink: (patch) => {
          const current = getStatus();
          setStatus({ ...current, ...patch });
        },
      });

      setStatus({
        ...getStatus(),
        running: true,
        lastStartAt: Date.now(),
      });

      // 返回一个 long-running Promise，和其他 channel 保持一致
      // 只有在 abortSignal 触发时才 resolve，确保 cleanup 被正确调用
      return new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          unregister();
          resolve();
          return;
        }
        abortSignal.addEventListener(
          "abort",
          () => {
            log?.info(`[${account.accountId}] Stopping WeChat Work (abort signal)`);
            unregister();
            resolve();
          },
          { once: true },
        );
      });
    },
    stopAccount: async (ctx) => {
      const { account, log, setStatus, getStatus } = ctx;
      log?.info(`[${account.accountId}] Stopping WeChat Work`);

      setStatus({
        ...getStatus(),
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
