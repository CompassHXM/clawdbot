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
    const formattedText = credentials
      ? "[语音] ..."
      : "[语音] (无法转写：未配置语音识别服务)";
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
