/**
 * WeChat Work 用户目录管理
 *
 * 维护用户名 ↔ UserID 的映射关系，支持：
 * 1. 收到消息时自动记录用户
 * 2. 通过用户名或 UserID 查找用户
 * 3. 持久化到 users.md 文件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

/**
 * 获取用户目录文件路径
 */
export function resolveUserDirectoryPath(workspacePath?: string): string {
  // 优先使用传入的路径，否则使用默认路径
  const base = workspacePath ?? process.env.MOLTBOT_WORKSPACE ?? process.cwd();
  return join(base, "wechat-users.json");
}

/**
 * 标准化用户目录（迁移旧数据）
 * - 将所有 key 转为小写
 * - 合并重复记录
 * - 确保 messageCount 有值
 */
function normalizeDirectory(data: WechatUserDirectory): WechatUserDirectory {
  const normalized: Record<string, WechatUserEntry> = {};

  for (const [key, entry] of Object.entries(data.users)) {
    const normalizedKey = key.toLowerCase();

    // 确保 messageCount 有值
    if (entry.messageCount === undefined || entry.messageCount === null) {
      entry.messageCount = 1;
    }

    const existing = normalized[normalizedKey];
    if (existing) {
      // 合并重复记录：保留更多信息的那个
      existing.firstSeenAt = Math.min(existing.firstSeenAt, entry.firstSeenAt);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, entry.lastSeenAt);
      existing.messageCount += entry.messageCount;
      if (!existing.name && entry.name) existing.name = entry.name;
      if (!existing.alias && entry.alias) existing.alias = entry.alias;
      // 保留原始大小写的 userId
      if (entry.userId && entry.userId !== entry.userId.toLowerCase()) {
        existing.userId = entry.userId;
      }
    } else {
      normalized[normalizedKey] = { ...entry };
    }
  }

  return { version: 1, users: normalized };
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
    directoryCache = normalizeDirectory({
      version: data.version ?? 1,
      users: data.users ?? {},
    });
    // 如果有变化，保存标准化后的数据
    if (JSON.stringify(data.users) !== JSON.stringify(directoryCache.users)) {
      saveUserDirectory(directoryCache);
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

  try {
    const dirPath = dirname(filePath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(dir, null, 2), "utf8");
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
    // 更新现有记录
    existing.lastSeenAt = now;
    existing.messageCount++;
    if (name && !existing.name) existing.name = name;
    if (alias) existing.alias = alias;
    saveUserDirectory(directory);
    return existing;
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
  saveUserDirectory(directory);
  return entry;
}

/**
 * 通过 userId 查找用户
 */
export function findUserById(userId: string): WechatUserEntry | null {
  const directory = loadUserDirectory();
  return directory.users[userId.toLowerCase()] ?? null;
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
      return entry;
    }
    // 精确匹配 name
    if (entry.name && entry.name.toLowerCase() === query) {
      return entry;
    }
    // 精确匹配 alias
    if (entry.alias && entry.alias.toLowerCase() === query) {
      return entry;
    }
  }

  // 模糊匹配
  for (const entry of Object.values(directory.users)) {
    if (entry.name && entry.name.toLowerCase().includes(query)) {
      return entry;
    }
    if (entry.alias && entry.alias.toLowerCase().includes(query)) {
      return entry;
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
export function listUsers(params?: {
  query?: string;
  limit?: number;
}): WechatUserEntry[] {
  const directory = loadUserDirectory();
  let users = Object.values(directory.users);

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
 */
export function setUserAlias(userId: string, alias: string): boolean {
  const directory = loadUserDirectory();
  const key = userId.toLowerCase();
  const entry = directory.users[key];
  if (!entry) return false;

  entry.alias = alias.trim() || undefined;
  saveUserDirectory(directory);
  return true;
}

/**
 * 清除缓存（用于测试或重新加载）
 */
export function clearDirectoryCache(): void {
  directoryCache = null;
  directoryPath = null;
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
 * 同步 users.md 文件
 */
export function syncUsersMd(workspacePath?: string): void {
  const base = workspacePath ?? process.env.MOLTBOT_WORKSPACE ?? process.cwd();
  const mdPath = join(base, "users.md");
  const content = generateUsersMd();
  try {
    writeFileSync(mdPath, content, "utf8");
  } catch (err) {
    console.warn(`[wechat] Failed to sync users.md: ${err}`);
  }
}
