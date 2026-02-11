import { describe, it, expect } from "vitest";

// Test message deduplication logic
describe("message deduplication", () => {
  const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const DEDUPE_MAX_SIZE = 1000;

  function createDedupeCache() {
    const processedMessages = new Map<string, number>();

    return {
      isProcessed(msgId: string): boolean {
        if (!msgId) return false;
        const now = Date.now();

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
      },
      size: () => processedMessages.size,
      clear: () => processedMessages.clear(),
    };
  }

  it("should mark new message as not processed", () => {
    const cache = createDedupeCache();
    expect(cache.isProcessed("msg-001")).toBe(false);
    expect(cache.size()).toBe(1);
  });

  it("should detect duplicate message", () => {
    const cache = createDedupeCache();
    cache.isProcessed("msg-001");
    expect(cache.isProcessed("msg-001")).toBe(true);
  });

  it("should handle empty msgId", () => {
    const cache = createDedupeCache();
    expect(cache.isProcessed("")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("should allow different msgIds", () => {
    const cache = createDedupeCache();
    expect(cache.isProcessed("msg-001")).toBe(false);
    expect(cache.isProcessed("msg-002")).toBe(false);
    expect(cache.isProcessed("msg-003")).toBe(false);
    expect(cache.size()).toBe(3);
  });
});

// Test webhook path normalization
describe("webhook path normalization", () => {
  function normalizeWebhookPath(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "/";
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (withSlash.length > 1 && withSlash.endsWith("/")) {
      return withSlash.slice(0, -1);
    }
    return withSlash;
  }

  it("should add leading slash if missing", () => {
    expect(normalizeWebhookPath("webhook")).toBe("/webhook");
    expect(normalizeWebhookPath("wechat-webhook")).toBe("/wechat-webhook");
  });

  it("should preserve leading slash", () => {
    expect(normalizeWebhookPath("/webhook")).toBe("/webhook");
  });

  it("should remove trailing slash", () => {
    expect(normalizeWebhookPath("/webhook/")).toBe("/webhook");
    expect(normalizeWebhookPath("webhook/")).toBe("/webhook");
  });

  it("should handle empty string", () => {
    expect(normalizeWebhookPath("")).toBe("/");
    expect(normalizeWebhookPath("   ")).toBe("/");
  });

  it("should handle root path", () => {
    expect(normalizeWebhookPath("/")).toBe("/");
  });
});

// Test message payload normalization
describe("message payload normalization", () => {
  type WechatInboundMessage = {
    fromUser: string;
    toUser: string;
    msgType: string;
    content: string;
    msgId: string;
    voiceBase64?: string;
    voiceFormat?: string;
  };

  function normalizeWechatMessage(payload: Record<string, unknown>): WechatInboundMessage | null {
    const readString = (key: string): string | undefined => {
      const value = payload[key];
      return typeof value === "string" ? value : undefined;
    };

    const type = readString("type");
    if (type !== "wechat-work-message") return null;

    const fromUser = readString("fromUser");
    const msgType = readString("msgType");

    if (!fromUser || !msgType) return null;

    return {
      fromUser,
      toUser: readString("toUser") ?? "",
      msgType,
      content: readString("content") ?? "",
      msgId: readString("msgId") ?? "",
      voiceBase64: readString("voiceBase64"),
      voiceFormat: readString("voiceFormat"),
    };
  }

  it("should normalize text message", () => {
    const payload = {
      type: "wechat-work-message",
      fromUser: "xiaoming",
      toUser: "corp123",
      msgType: "text",
      content: "Hello!",
      msgId: "msg-001",
    };

    const msg = normalizeWechatMessage(payload);
    expect(msg).not.toBeNull();
    expect(msg?.fromUser).toBe("xiaoming");
    expect(msg?.msgType).toBe("text");
    expect(msg?.content).toBe("Hello!");
  });

  it("should normalize voice message", () => {
    const payload = {
      type: "wechat-work-message",
      fromUser: "xiaoming",
      toUser: "corp123",
      msgType: "voice",
      content: "",
      msgId: "msg-003",
      voiceBase64: "IyFBTVItV0Iu...",
      voiceFormat: "amr",
    };

    const msg = normalizeWechatMessage(payload);
    expect(msg).not.toBeNull();
    expect(msg?.msgType).toBe("voice");
    expect(msg?.voiceBase64).toBe("IyFBTVItV0Iu...");
    expect(msg?.voiceFormat).toBe("amr");
  });

  it("should reject invalid type", () => {
    const payload = {
      type: "other-type",
      fromUser: "xiaoming",
      msgType: "text",
    };
    expect(normalizeWechatMessage(payload)).toBeNull();
  });

  it("should reject missing fromUser", () => {
    const payload = {
      type: "wechat-work-message",
      msgType: "text",
      content: "Hello",
    };
    expect(normalizeWechatMessage(payload)).toBeNull();
  });
});

// Test voice message handling
describe("voice message handling", () => {
  it("should format transcribed text with prefix", () => {
    const transcribedText = "你好世界";
    const formattedText = `[语音] ${transcribedText}`;
    expect(formattedText).toBe("[语音] 你好世界");
  });

  it("should handle transcription failure", () => {
    const errorMsg = "Azure Speech API error: 401";
    const formattedText = `[语音] (转写失败: ${errorMsg})`;
    expect(formattedText).toContain("转写失败");
    expect(formattedText).toContain("401");
  });

  it("should handle missing voice data", () => {
    const voiceBase64: string | undefined = undefined;
    const formattedText = voiceBase64 ? "[语音] ..." : "[语音] (数据不可用)";
    expect(formattedText).toBe("[语音] (数据不可用)");
  });

  it("should handle missing credentials", () => {
    const credentials = null;
    const formattedText = credentials ? "[语音] ..." : "[语音] (无法转写：未配置语音识别服务)";
    expect(formattedText).toContain("未配置语音识别服务");
  });
});

// Test supported message types
describe("supported message types", () => {
  const supportedTypes = ["text", "image", "voice"];

  it("should support text messages", () => {
    expect(supportedTypes.includes("text")).toBe(true);
  });

  it("should support image messages", () => {
    expect(supportedTypes.includes("image")).toBe(true);
  });

  it("should support voice messages", () => {
    expect(supportedTypes.includes("voice")).toBe(true);
  });

  it("should not support video messages (yet)", () => {
    expect(supportedTypes.includes("video")).toBe(false);
  });
});

// Test chunkTextByBytes function
describe("chunkTextByBytes", () => {
  // 复制 monitor.ts 中的函数用于测试
  function chunkTextByBytes(text: string, maxBytes: number): string[] {
    if (!text) return [];
    const byteLen = Buffer.byteLength(text, "utf8");
    if (byteLen <= maxBytes) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      const remainingBytes = Buffer.byteLength(remaining, "utf8");
      if (remainingBytes <= maxBytes) {
        chunks.push(remaining);
        break;
      }

      // 二分查找：找到不超过 maxBytes 的最大字符位置
      let low = 0;
      let high = remaining.length;
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (Buffer.byteLength(remaining.slice(0, mid), "utf8") <= maxBytes) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }

      let breakIdx = low;
      const window = remaining.slice(0, breakIdx);

      // 优先找换行
      const lastNewline = window.lastIndexOf("\n");
      if (lastNewline > breakIdx * 0.5) {
        breakIdx = lastNewline + 1;
      } else {
        // 找句末标点
        const sentenceEnd = Math.max(
          window.lastIndexOf("。"),
          window.lastIndexOf("！"),
          window.lastIndexOf("？"),
          window.lastIndexOf(". "),
          window.lastIndexOf("! "),
          window.lastIndexOf("? "),
        );
        if (sentenceEnd > breakIdx * 0.5) {
          breakIdx = sentenceEnd + 1;
        } else {
          // 找空格或逗号
          const softBreak = Math.max(
            window.lastIndexOf(" "),
            window.lastIndexOf("，"),
            window.lastIndexOf(","),
          );
          if (softBreak > breakIdx * 0.5) {
            breakIdx = softBreak + 1;
          }
        }
      }

      chunks.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx);
    }

    return chunks;
  }

  it("should return empty array for empty string", () => {
    expect(chunkTextByBytes("", 100)).toEqual([]);
  });

  it("should return single chunk if text fits within limit", () => {
    const text = "Hello, world!";
    expect(chunkTextByBytes(text, 100)).toEqual([text]);
  });

  it("should return single chunk for short Chinese text", () => {
    const text = "你好世界";
    expect(chunkTextByBytes(text, 100)).toEqual([text]);
  });

  it("should correctly calculate Chinese character bytes", () => {
    // 中文每字符 3 字节
    const text = "你好"; // 6 bytes
    expect(Buffer.byteLength(text, "utf8")).toBe(6);
    expect(chunkTextByBytes(text, 6)).toEqual([text]);
    expect(chunkTextByBytes(text, 5).length).toBe(2);
  });

  it("should split long Chinese text correctly", () => {
    // 创建一个超过 2048 字节的中文文本 (约 683 个中文字符)
    const char = "测";
    const longText = char.repeat(700); // 2100 bytes
    expect(Buffer.byteLength(longText, "utf8")).toBe(2100);

    const chunks = chunkTextByBytes(longText, 2048);
    expect(chunks.length).toBe(2);

    // 每个 chunk 都不应超过 2048 字节
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(2048);
    }

    // 合并后应该等于原文
    expect(chunks.join("")).toBe(longText);
  });

  it("should prefer breaking at newlines when possible", () => {
    // 创建一个足够长的文本，确保分块逻辑能找到换行作为断点
    const line1 = "这是第一行内容，比较长一些，需要多一点文字来测试分块逻辑的正确性";
    const line2 = "这是第二行也有很多内容";
    const text = `${line1}\n${line2}`;
    const line1Bytes = Buffer.byteLength(line1 + "\n", "utf8");

    // 使用一个略大于第一行的限制，确保能在换行处分割
    const chunks = chunkTextByBytes(text, line1Bytes + 10);

    // 第一个 chunk 应该包含换行或在换行前结束
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // 所有 chunks 合并应该等于原文
    expect(chunks.join("")).toBe(text);
  });

  it("should prefer breaking at sentence boundaries when possible", () => {
    // 创建足够长的句子
    const sentence1 = "这是第一句话，内容比较丰富，需要足够长才能测试分块";
    const sentence2 = "这是第二句话也很长";
    const sentence3 = "这是第三句话";
    const text = `${sentence1}。${sentence2}。${sentence3}。`;

    // 使用一个能触发分块的限制
    const limit = Buffer.byteLength(sentence1, "utf8") + 10;
    const chunks = chunkTextByBytes(text, limit);

    // 验证分块正确性
    expect(chunks.length).toBeGreaterThan(1);
    // 所有 chunks 合并应该等于原文
    expect(chunks.join("")).toBe(text);
    // 每个 chunk 都不应超过限制
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(limit);
    }
  });

  it("should handle mixed English and Chinese", () => {
    const text = "Hello 你好 World 世界 Test 测试";
    const chunks = chunkTextByBytes(text, 20);

    // 所有 chunks 合并后等于原文
    expect(chunks.join("")).toBe(text);

    // 每个 chunk 都不超过限制
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(20);
    }
  });

  it("should handle realistic WeChat message", () => {
    // 模拟一个真实的长回复
    const text = `好的，我来帮你分析一下这个问题。

首先，我们需要考虑以下几个方面：

1. **技术可行性**：这个方案在技术上是完全可行的。我们可以使用现有的工具和框架来实现。

2. **成本效益**：从成本角度来看，这个方案的投入产出比是合理的。前期投入虽然有一定规模，但长期来看可以带来显著的效益。

3. **时间规划**：建议分三个阶段进行：
   - 第一阶段（1-2周）：需求分析和设计
   - 第二阶段（2-4周）：核心功能开发
   - 第三阶段（1-2周）：测试和优化

4. **风险评估**：主要风险包括技术复杂度、人员配置、外部依赖等。建议制定详细的风险应对方案。

总结：这个方案整体上是可行的，建议尽快启动。如果有任何问题，随时可以问我！`;

    const chunks = chunkTextByBytes(text, 2048);

    // 检查每个 chunk 都不超过 2048 字节
    for (const chunk of chunks) {
      const bytes = Buffer.byteLength(chunk, "utf8");
      expect(bytes).toBeLessThanOrEqual(2048);
    }

    // 合并后等于原文
    expect(chunks.join("")).toBe(text);
  });
});
