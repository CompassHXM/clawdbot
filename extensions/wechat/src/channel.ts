import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, mkdtempSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { getWechatRuntime } from "./runtime.js";
import { listUsers, resolveUserId, type WechatUserEntry } from "./user-directory.js";

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

/**
 * 发送语音消息
 */
export async function sendWorkWechatVoice(params: {
  corpId: string;
  secret: string;
  agentId: string;
  toUser: string;
  mediaId: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { corpId, secret, agentId, toUser, mediaId } = params;

  try {
    const token = await getAccessToken(corpId, secret);
    const url = `${WORK_WECHAT_API}/message/send?access_token=${token}`;

    const body = {
      touser: toUser,
      msgtype: "voice",
      agentid: Number.parseInt(agentId, 10),
      voice: { media_id: mediaId },
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

/**
 * 发送图片/视频/文件消息（通用媒体发送）
 * 语音消息使用专门的 sendWorkWechatVoice
 */
export async function sendWorkWechatMedia(params: {
  corpId: string;
  secret: string;
  agentId: string;
  toUser: string;
  mediaId: string;
  msgType: "image" | "video" | "file";
  title?: string; // video only
  description?: string; // video only
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { corpId, secret, agentId, toUser, mediaId, msgType, title, description } = params;

  try {
    const token = await getAccessToken(corpId, secret);
    const url = `${WORK_WECHAT_API}/message/send?access_token=${token}`;

    const mediaBody: Record<string, unknown> = { media_id: mediaId };
    if (msgType === "video") {
      if (title) mediaBody.title = title;
      if (description) mediaBody.description = description;
    }

    const body = {
      touser: toUser,
      msgtype: msgType,
      agentid: Number.parseInt(agentId, 10),
      [msgType]: mediaBody,
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

/**
 * 上传临时素材到企业微信
 * @param type - 媒体类型: image, voice, video, file
 * @param filePath - 本地文件路径
 * @returns media_id (3天有效)
 */
export async function uploadMedia(params: {
  corpId: string;
  secret: string;
  type: "image" | "voice" | "video" | "file";
  filePath: string;
  fileName?: string;
}): Promise<{ ok: boolean; mediaId?: string; error?: string }> {
  const { corpId, secret, type, filePath, fileName } = params;

  try {
    const token = await getAccessToken(corpId, secret);
    const url = `${WORK_WECHAT_API}/media/upload?access_token=${token}&type=${type}`;

    // 读取文件
    const fileBuffer = readFileSync(filePath);
    const finalFileName = fileName ?? `upload${extname(filePath)}`;

    // 构建 multipart/form-data
    const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
    const contentType = type === "voice" ? "audio/amr" : "application/octet-stream";

    const header = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="media"; filename="${finalFileName}"; filelength=${fileBuffer.length}\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    });

    const data = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      type?: string;
      media_id?: string;
      created_at?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      return { ok: false, error: `${data.errmsg} (code: ${data.errcode})` };
    }

    if (!data.media_id) {
      return { ok: false, error: "No media_id returned" };
    }

    return { ok: true, mediaId: data.media_id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** 媒体类型 */
export type MediaType = "image" | "voice" | "video" | "file";

/** 企业微信各媒体类型上传大小限制 */
const MEDIA_SIZE_LIMITS: Record<MediaType, number> = {
  image: 10 * 1024 * 1024, // 10MB
  voice: 2 * 1024 * 1024, // 2MB
  video: 10 * 1024 * 1024, // 10MB
  file: 20 * 1024 * 1024, // 20MB
};

/** 各媒体类型的扩展名映射 */
const MEDIA_TYPE_EXTENSIONS: Record<string, MediaType> = {
  // voice
  ".amr": "voice",
  ".mp3": "voice",
  ".wav": "voice",
  ".opus": "voice",
  ".ogg": "voice",
  ".m4a": "voice",
  ".aac": "voice",
  ".flac": "voice",
  // image
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".bmp": "image",
  ".webp": "image",
  // video
  ".mp4": "video",
  ".mov": "video",
  ".avi": "video",
  ".wmv": "video",
  ".mkv": "video",
};

/**
 * 根据文件扩展名检测媒体类型
 * 未匹配的扩展名默认为 "file"
 */
export function detectMediaType(filePath: string): MediaType {
  const ext = extname(filePath).toLowerCase();
  return MEDIA_TYPE_EXTENSIONS[ext] ?? "file";
}

/**
 * 检测文件是否是音频格式（保留向后兼容，内部使用 detectMediaType）
 */
function isAudioFile(filePath: string): boolean {
  return detectMediaType(filePath) === "voice";
}

/**
 * 将音频文件转换为 AMR 格式 (企业微信语音要求)
 * 要求: AMR 格式, ≤2MB, ≤60s
 */
function convertToAmr(
  inputPath: string,
): { ok: true; amrPath: string; cleanup: () => void } | { ok: false; error: string } {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "wechat-voice-"));
    const amrPath = join(tempDir, "voice.amr");

    // 使用 ffmpeg 转换为 AMR-NB 格式
    // -ar 8000: AMR 标准采样率
    // -ac 1: 单声道
    // -c:a libopencore_amrnb: 明确指定 AMR-NB 编码器
    execFileSync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb", amrPath],
      {
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const cleanup = () => {
      try {
        unlinkSync(amrPath);
        if (tempDir) {
          rmdirSync(tempDir);
        }
      } catch {
        // ignore cleanup errors
      }
    };

    return { ok: true, amrPath, cleanup };
  } catch (err) {
    // 清理临时目录
    if (tempDir) {
      try {
        rmdirSync(tempDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `AMR conversion failed: ${message}` };
  }
}

/**
 * 发送媒体消息
 * 自动检测媒体类型（音频/图片/视频/文件），走对应的上传+发送流程
 * 支持 fallback 到文本
 */
export async function sendMedia(params: {
  corpId: string;
  secret: string;
  agentId: string;
  toUser: string;
  mediaUrl: string;
  text?: string;
  /** 如果媒体发送失败，是否 fallback 到文本消息 */
  fallbackToText?: boolean;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { corpId, secret, agentId, toUser, mediaUrl, text, fallbackToText = false } = params;

  // 本地文件路径（非 HTTP URL）
  if (mediaUrl && !mediaUrl.startsWith("http")) {
    const mediaType = detectMediaType(mediaUrl);

    // 文件大小检查
    try {
      const stat = statSync(mediaUrl);
      const sizeLimit = MEDIA_SIZE_LIMITS[mediaType];
      if (stat.size > sizeLimit) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        const limitMB = (sizeLimit / 1024 / 1024).toFixed(0);
        const error = `File too large: ${sizeMB}MB exceeds ${mediaType} limit of ${limitMB}MB`;
        console.error(`[wechat] ${error}`);
        if (fallbackToText) {
          const content = text || `[文件过大: ${sizeMB}MB，上限 ${limitMB}MB]`;
          return sendWorkWechatMessage({ corpId, secret, agentId, toUser, content });
        }
        return { ok: false, error };
      }
    } catch (err) {
      const error = `File not accessible: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[wechat] ${error}`);
      if (fallbackToText) {
        const content = text || "[文件不存在或无法访问]";
        return sendWorkWechatMessage({ corpId, secret, agentId, toUser, content });
      }
      return { ok: false, error };
    }

    // === 语音消息 ===
    if (mediaType === "voice") {
      const convertResult = convertToAmr(mediaUrl);
      if (!convertResult.ok) {
        console.error(`[wechat] voice conversion failed: ${convertResult.error}`);
        if (fallbackToText) {
          const content = text || "[语音转换失败]";
          return sendWorkWechatMessage({ corpId, secret, agentId, toUser, content });
        }
        return { ok: false, error: convertResult.error };
      }

      try {
        const uploadResult = await uploadMedia({
          corpId,
          secret,
          type: "voice",
          filePath: convertResult.amrPath,
          fileName: "voice.amr",
        });

        if (!uploadResult.ok || !uploadResult.mediaId) {
          console.error(`[wechat] voice upload failed: ${uploadResult.error}`);
          if (fallbackToText) {
            const content = text || "[语音上传失败]";
            return sendWorkWechatMessage({ corpId, secret, agentId, toUser, content });
          }
          return { ok: false, error: uploadResult.error ?? "Upload failed" };
        }

        const result = await sendWorkWechatVoice({
          corpId,
          secret,
          agentId,
          toUser,
          mediaId: uploadResult.mediaId,
        });

        return result;
      } finally {
        convertResult.cleanup();
      }
    }

    // === 图片/视频/文件消息 ===
    const uploadResult = await uploadMedia({
      corpId,
      secret,
      type: mediaType,
      filePath: mediaUrl,
    });

    if (!uploadResult.ok || !uploadResult.mediaId) {
      const error = uploadResult.error ?? "Upload failed";
      console.error(`[wechat] ${mediaType} upload failed: ${error}`);
      if (fallbackToText) {
        const content = text || `[${mediaType}上传失败]`;
        return sendWorkWechatMessage({ corpId, secret, agentId, toUser, content });
      }
      return { ok: false, error };
    }

    // 发送媒体消息
    const mediaResult = await sendWorkWechatMedia({
      corpId,
      secret,
      agentId,
      toUser,
      mediaId: uploadResult.mediaId,
      msgType: mediaType,
    });

    if (!mediaResult.ok) {
      console.error(`[wechat] ${mediaType} send failed: ${mediaResult.error}`);
      if (fallbackToText) {
        const content = text || `[${mediaType}发送失败]`;
        return sendWorkWechatMessage({ corpId, secret, agentId, toUser, content });
      }
      return mediaResult;
    }

    // 图片/视频/文件消息不支持附带文本，如果有 text 则单独发一条
    if (text) {
      await sendWorkWechatMessage({ corpId, secret, agentId, toUser, content: text });
    }

    return mediaResult;
  }

  // 非本地文件（HTTP URL 或其他），发送文本 + 链接
  const content = text ? `${text}\n${mediaUrl}` : mediaUrl;
  return sendWorkWechatMessage({
    corpId,
    secret,
    agentId,
    toUser,
    content,
  });
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

      // 使用公共的 sendMedia 函数，启用 fallback 到文本
      const result = await sendMedia({
        corpId,
        secret,
        agentId,
        toUser: to,
        mediaUrl: mediaUrl ?? "",
        text,
        fallbackToText: true,
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
