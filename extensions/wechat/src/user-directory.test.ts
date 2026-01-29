import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  recordUser,
  findUserById,
  findUserByName,
  resolveUserId,
  listUsers,
  setUserAlias,
  clearDirectoryCache,
  generateUsersMd,
  resolveUserDirectoryPath,
} from "./user-directory.js";

// Use a test-specific directory
const TEST_DIR = join(process.cwd(), ".test-wechat-users");

describe("user-directory", () => {
  beforeEach(() => {
    // Clear the cache and remove any test files
    clearDirectoryCache();
    const jsonPath = resolveUserDirectoryPath(TEST_DIR);
    const mdPath = join(TEST_DIR, "users.md");
    try {
      if (existsSync(jsonPath)) unlinkSync(jsonPath);
      if (existsSync(mdPath)) unlinkSync(mdPath);
    } catch {
      // ignore
    }
    // Set test environment
    process.env.MOLTBOT_WORKSPACE = TEST_DIR;
  });

  afterAll(() => {
    // Clean up test directory
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.MOLTBOT_WORKSPACE;
  });

  describe("recordUser", () => {
    it("should record a new user", () => {
      const entry = recordUser({ userId: "xiaoming" });
      expect(entry.userId).toBe("xiaoming");
      expect(entry.messageCount).toBe(1);
      expect(entry.firstSeenAt).toBeGreaterThan(0);
    });

    it("should update existing user on subsequent messages", () => {
      recordUser({ userId: "xiaoming" });
      const entry = recordUser({ userId: "xiaoming" });
      expect(entry.messageCount).toBe(2);
    });

    it("should handle case-insensitive userId", () => {
      recordUser({ userId: "XiaoMing" });
      const entry = recordUser({ userId: "xiaoming" });
      expect(entry.messageCount).toBe(2);
    });
  });

  describe("findUserById", () => {
    it("should find user by exact userId", () => {
      recordUser({ userId: "xiaoming" });
      const found = findUserById("xiaoming");
      expect(found).not.toBeNull();
      expect(found?.userId).toBe("xiaoming");
    });

    it("should be case-insensitive", () => {
      recordUser({ userId: "XiaoMing" });
      const found = findUserById("xiaoming");
      expect(found).not.toBeNull();
    });

    it("should return null for unknown user", () => {
      const found = findUserById("unknown");
      expect(found).toBeNull();
    });
  });

  describe("findUserByName", () => {
    it("should find by name", () => {
      recordUser({ userId: "xiaoming", name: "小明" });
      const found = findUserByName("小明");
      expect(found).not.toBeNull();
      expect(found?.userId).toBe("xiaoming");
    });

    it("should find by alias", () => {
      recordUser({ userId: "xiaoming", alias: "ming" });
      const found = findUserByName("ming");
      expect(found).not.toBeNull();
    });

    it("should do partial match", () => {
      recordUser({ userId: "xiaoming", name: "小明同学" });
      const found = findUserByName("小明");
      expect(found).not.toBeNull();
    });
  });

  describe("resolveUserId", () => {
    it("should resolve known userId", () => {
      recordUser({ userId: "xiaoming" });
      expect(resolveUserId("xiaoming")).toBe("xiaoming");
    });

    it("should resolve by name", () => {
      recordUser({ userId: "xiaoming", name: "小明" });
      expect(resolveUserId("小明")).toBe("xiaoming");
    });

    it("should strip wechat: prefix", () => {
      recordUser({ userId: "xiaoming" });
      expect(resolveUserId("wechat:xiaoming")).toBe("xiaoming");
    });

    it("should return original for unknown user", () => {
      expect(resolveUserId("newuser")).toBe("newuser");
    });

    it("should return null for empty input", () => {
      expect(resolveUserId("")).toBeNull();
    });
  });

  describe("listUsers", () => {
    it("should list all users", () => {
      recordUser({ userId: "user1" });
      recordUser({ userId: "user2" });
      const users = listUsers();
      expect(users.length).toBe(2);
    });

    it("should filter by query", () => {
      recordUser({ userId: "xiaoming", name: "小明" });
      recordUser({ userId: "xiaohong", name: "小红" });
      const users = listUsers({ query: "小明" });
      expect(users.length).toBe(1);
      expect(users[0].userId).toBe("xiaoming");
    });

    it("should respect limit", () => {
      recordUser({ userId: "user1" });
      recordUser({ userId: "user2" });
      recordUser({ userId: "user3" });
      const users = listUsers({ limit: 2 });
      expect(users.length).toBe(2);
    });
  });

  describe("setUserAlias", () => {
    it("should set alias for existing user", () => {
      recordUser({ userId: "xiaoming" });
      const result = setUserAlias("xiaoming", "ming");
      expect(result).toBe(true);
      const found = findUserByName("ming");
      expect(found?.userId).toBe("xiaoming");
    });

    it("should return false for unknown user", () => {
      const result = setUserAlias("unknown", "alias");
      expect(result).toBe(false);
    });
  });

  describe("generateUsersMd", () => {
    it("should generate markdown for empty directory", () => {
      const md = generateUsersMd();
      expect(md).toContain("暂无已知用户");
    });

    it("should include user table", () => {
      recordUser({ userId: "xiaoming", name: "小明" });
      const md = generateUsersMd();
      expect(md).toContain("xiaoming");
      expect(md).toContain("小明");
    });
  });
});
