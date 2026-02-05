/**
 * WeChat Work 用户目录管理
 *
 * 维护用户名 ↔ UserID 的映射关系，支持：
 * 1. 收到消息时自动记录用户
 * 2. 通过用户名或 UserID 查找用户
 * 3. 持久化到 users.md 文件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WechatUserEntry = {
  userId: string; // 企业微信 UserID (FromUserName)
  name?: string; // 用户显示名（可选，需要通过 API 获取）
  alias?: string; // 用户设置的别名（方便查找）
  firstSeenAt: number; // 首次对话时间 (Unix timestamp ms)
  lastSeenAt: number; // 最后对话时间
  messageCount: number; // 消息计数
};

export type WechatUserDirectory = {
  version: 1;
  users: Record<string, WechatUserEntry>; // key = userId (lowercase)
};

// 内存缓存
let directoryCache: WechatUserDirectory | null = null;
let directoryPath: string | null = null;
let isDirty = false; // 标记缓存是否被修改过

// users.md 同步相关
let syncUsersMdTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_USERS_MD_DEBOUNCE_MS = 5000; // 5 秒 debounce

/**
 * 获取 OpenClaw 状态目录路径
 * 优先级: OPENCLAW_STATE_DIR > CLAWDBOT_STATE_DIR > ~/.openclaw
 */
function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), ".openclaw");
}

/**
 * 获取用户目录文件路径
 */
export function resolveUserDirectoryPath(workspacePath?: string): string {
  // 优先使用传入的路径，否则使用 OpenClaw 状态目录
  const base = workspacePath ?? resolveStateDir();
  return join(base, "wechat-users.json");
}

/**
 * 标准化用户目录（迁移旧数据）
 * - 将所有 key 转为小写
 * - 合并重复记录
 * - 确保 messageCount 有值
 *
 * 注意：此函数不修改输入对象，返回全新的对象
 */
function normalizeDirectory(data: WechatUserDirectory): {
  directory: WechatUserDirectory;
  changed: boolean;
} {
  const normalized: Record<string, WechatUserEntry> = {};
  let changed = false;

  for (const [key, entry] of Object.entries(data.users)) {
    const normalizedKey = key.toLowerCase();

    // 创建 entry 的深拷贝，避免修改原始对象
    const entryCopy: WechatUserEntry = {
      userId: entry.userId,
      name: entry.name,
      alias: entry.alias,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      messageCount: entry.messageCount,
    };

    // 确保 messageCount 有值
    if (entryCopy.messageCount === undefined || entryCopy.messageCount === null) {
      entryCopy.messageCount = 1;
      changed = true;
    }

    // 检查 key 是否需要标准化
    if (key !== normalizedKey) {
      changed = true;
    }

    const existing = normalized[normalizedKey];
    if (existing) {
      // 合并重复记录：保留更多信息的那个
      changed = true;
      existing.firstSeenAt = Math.min(existing.firstSeenAt, entryCopy.firstSeenAt);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, entryCopy.lastSeenAt);
      existing.messageCount += entryCopy.messageCount;
      if (!existing.name && entryCopy.name) existing.name = entryCopy.name;
      if (!existing.alias && entryCopy.alias) existing.alias = entryCopy.alias;
      // 保留原始大小写的 userId
      if (entryCopy.userId && entryCopy.userId !== entryCopy.userId.toLowerCase()) {
        existing.userId = entryCopy.userId;
      }
    } else {
      normalized[normalizedKey] = entryCopy;
    }
  }

  return {
    directory: { version: 1, users: normalized },
    changed,
  };
}

/**
 * 加载用户目录
 */
export function loadUserDirectory(path?: string): WechatUserDirectory {
  const filePath = path ?? directoryPath ?? resolveUserDirectoryPath();
  directoryPath = filePath;

  if (directoryCache) {
    return directoryCache;
  }

  if (!existsSync(filePath)) {
    directoryCache = { version: 1, users: {} };
    return directoryCache;
  }

  try {
    const content = readFileSync(filePath, "utf8");
    const data = JSON.parse(content) as WechatUserDirectory;
    // 标准化数据（处理旧格式）
    const { directory, changed } = normalizeDirectory({
      version: data.version ?? 1,
      users: data.users ?? {},
    });
    directoryCache = directory;

    // 仅当数据实际发生变化时才保存
    if (changed) {
      saveUserDirectory();
    }
    return directoryCache;
  } catch (err) {
    console.warn(`[wechat] Failed to load user directory: ${err}`);
    directoryCache = { version: 1, users: {} };
    return directoryCache;
  }
}

/**
 * 保存用户目录
 */
export function saveUserDirectory(directory?: WechatUserDirectory): void {
  const dir = directory ?? directoryCache;
  if (!dir) return;

  const filePath = directoryPath ?? resolveUserDirectoryPath();
  directoryPath = filePath;

  // 如果传入了显式的 directory，同步更新缓存
  if (directory && directory !== directoryCache) {
    directoryCache = directory;
  }

  try {
    const dirPath = dirname(filePath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(dir, null, 2), "utf8");
    isDirty = false;
  } catch (err) {
    console.error(`[wechat] Failed to save user directory: ${err}`);
  }
}

/**
 * 记录用户（收到消息时调用）
 */
export function recordUser(params: {
  userId: string;
  name?: string;
  alias?: string;
}): WechatUserEntry {
  const { userId, name, alias } = params;
  const directory = loadUserDirectory();
  const key = userId.toLowerCase();
  const now = Date.now();

  const existing = directory.users[key];
  if (existing) {
    // 更新现有记录（创建新对象以避免对缓存对象进行原地修改）
    const updated: WechatUserEntry = {
      ...existing,
      lastSeenAt: now,
      messageCount: existing.messageCount + 1,
      // 仅在原来没有 name 且本次提供了 name 时更新 name
      ...(name && !existing.name ? { name } : {}),
      // alias 每次提供则覆盖
      ...(alias ? { alias } : {}),
    };
    directory.users[key] = updated;
    saveUserDirectory();
    return updated;
  }

  // 创建新记录
  const entry: WechatUserEntry = {
    userId,
    name,
    alias,
    firstSeenAt: now,
    lastSeenAt: now,
    messageCount: 1,
  };
  directory.users[key] = entry;
  saveUserDirectory();
  return entry;
}

/**
 * 通过 userId 查找用户
 */
export function findUserById(userId: string): WechatUserEntry | null {
  const directory = loadUserDirectory();
  const entry = directory.users[userId.toLowerCase()];
  // 返回拷贝以避免外部修改缓存
  return entry ? { ...entry } : null;
}

/**
 * 通过名称或别名查找用户
 */
export function findUserByName(nameOrAlias: string): WechatUserEntry | null {
  const directory = loadUserDirectory();
  const query = nameOrAlias.toLowerCase().trim();

  for (const entry of Object.values(directory.users)) {
    // 精确匹配 userId
    if (entry.userId.toLowerCase() === query) {
      return { ...entry };
    }
    // 精确匹配 name
    if (entry.name && entry.name.toLowerCase() === query) {
      return { ...entry };
    }
    // 精确匹配 alias
    if (entry.alias && entry.alias.toLowerCase() === query) {
      return { ...entry };
    }
  }

  // 模糊匹配
  for (const entry of Object.values(directory.users)) {
    if (entry.name && entry.name.toLowerCase().includes(query)) {
      return { ...entry };
    }
    if (entry.alias && entry.alias.toLowerCase().includes(query)) {
      return { ...entry };
    }
  }

  return null;
}

/**
 * 解析目标用户 ID
 * 支持：
 * - 直接 userId
 * - 用户名/别名
 * - wechat:userId 格式
 *
 * 注意：如果找不到用户，会返回原始值（可能是新用户或外部指定的 userId）。
 * 调用方应该处理无效 userId 的情况。
 */
export function resolveUserId(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  // 移除 wechat: 前缀
  const cleaned = trimmed.replace(/^wechat:/i, "").trim();
  if (!cleaned) return null;

  // 先尝试直接作为 userId 查找
  const byId = findUserById(cleaned);
  if (byId) return byId.userId;

  // 再尝试作为名称/别名查找
  const byName = findUserByName(cleaned);
  if (byName) return byName.userId;

  // 如果都找不到，返回原始值（可能是新用户或外部指定的 userId）
  return cleaned;
}

/**
 * 列出所有已知用户
 */
export function listUsers(params?: { query?: string; limit?: number }): WechatUserEntry[] {
  const directory = loadUserDirectory();
  // 返回拷贝以避免外部修改缓存
  let users = Object.values(directory.users).map((u) => ({ ...u }));

  // 按最后活跃时间排序
  users.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  // 过滤
  if (params?.query) {
    const q = params.query.toLowerCase();
    users = users.filter(
      (u) =>
        u.userId.toLowerCase().includes(q) ||
        u.name?.toLowerCase().includes(q) ||
        u.alias?.toLowerCase().includes(q),
    );
  }

  // 限制数量
  if (params?.limit && params.limit > 0) {
    users = users.slice(0, params.limit);
  }

  return users;
}

/**
 * 设置用户别名
 *
 * @returns 更新后的用户条目；如果用户不存在则返回 undefined
 */
export function setUserAlias(userId: string, alias: string): WechatUserEntry | undefined {
  const directory = loadUserDirectory();
  const key = userId.toLowerCase();
  const entry = directory.users[key];
  if (!entry) return undefined;

  // 创建新对象以避免原地修改
  const updated: WechatUserEntry = {
    ...entry,
    alias: alias.trim() || undefined,
  };
  directory.users[key] = updated;
  saveUserDirectory();
  return updated;
}

/**
 * 清除缓存（用于测试或重新加载）
 */
export function clearDirectoryCache(): void {
  directoryCache = null;
  directoryPath = null;
  isDirty = false;
  if (syncUsersMdTimer) {
    clearTimeout(syncUsersMdTimer);
    syncUsersMdTimer = null;
  }
}

/**
 * 生成 users.md 格式的用户列表（用于人类阅读）
 */
export function generateUsersMd(): string {
  const directory = loadUserDirectory();
  const users = Object.values(directory.users).sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  if (users.length === 0) {
    return "# WeChat Work 用户目录\n\n暂无已知用户。\n";
  }

  const lines = [
    "# WeChat Work 用户目录",
    "",
    `共 ${users.length} 位用户`,
    "",
    "| UserID | 名称 | 别名 | 首次对话 | 最后活跃 | 消息数 |",
    "|--------|------|------|----------|----------|--------|",
  ];

  for (const user of users) {
    const firstSeen = new Date(user.firstSeenAt).toISOString().split("T")[0];
    const lastSeen = new Date(user.lastSeenAt).toISOString().split("T")[0];
    lines.push(
      `| ${user.userId} | ${user.name ?? "-"} | ${user.alias ?? "-"} | ${firstSeen} | ${lastSeen} | ${user.messageCount} |`,
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * 同步 users.md 文件（带 debounce，避免频繁写入）
 */
export function syncUsersMd(workspacePath?: string): void {
  // 取消之前的定时器
  if (syncUsersMdTimer) {
    clearTimeout(syncUsersMdTimer);
  }

  // 设置新的定时器，debounce 5 秒
  syncUsersMdTimer = setTimeout(() => {
    syncUsersMdTimer = null;
    const base = workspacePath ?? resolveStateDir();
    const mdPath = join(base, "users.md");
    const content = generateUsersMd();
    try {
      writeFileSync(mdPath, content, "utf8");
    } catch (err) {
      console.warn(`[wechat] Failed to sync users.md: ${err}`);
    }
  }, SYNC_USERS_MD_DEBOUNCE_MS);
}

/**
 * 立即同步 users.md 文件（不使用 debounce，用于关闭时调用）
 */
export function syncUsersMdImmediately(workspacePath?: string): void {
  // 取消之前的定时器
  if (syncUsersMdTimer) {
    clearTimeout(syncUsersMdTimer);
    syncUsersMdTimer = null;
  }

  const base = workspacePath ?? resolveStateDir();
  const mdPath = join(base, "users.md");
  const content = generateUsersMd();
  try {
    writeFileSync(mdPath, content, "utf8");
  } catch (err) {
    console.warn(`[wechat] Failed to sync users.md: ${err}`);
  }
}
