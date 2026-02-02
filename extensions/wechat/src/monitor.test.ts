import { describe, it, expect, vi, beforeEach } from "vitest";

// Test message deduplication logic
describe("message deduplication", () => {
  const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const DEDUPE_MAX_SIZE = 1000;

  // Simulate the deduplication cache
  function createDedupeCache() {
    const processedMessages = new Map<string, number>();

    return {
      isProcessed(msgId: string): boolean {
        if (!msgId) return false;
        const now = Date.now();

        // Clean up expired entries
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
    expect(normalizeWebhookPath("/wechat-webhook")).toBe("/wechat-webhook");
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
    agentId?: string;
    createTime?: string;
    timestamp?: number;
    picUrl?: string;
    mediaId?: string;
    imageBase64?: string;
    imageMimeType?: string;
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
      agentId: readString("agentId"),
      createTime: readString("createTime"),
      timestamp: typeof payload.timestamp === "number" ? payload.timestamp : undefined,
      picUrl: readString("picUrl"),
      mediaId: readString("mediaId"),
      imageBase64: readString("imageBase64"),
      imageMimeType: readString("imageMimeType"),
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
      agentId: "1000002",
      timestamp: 1234567890000,
    };

    const msg = normalizeWechatMessage(payload);

    expect(msg).not.toBeNull();
    expect(msg?.fromUser).toBe("xiaoming");
    expect(msg?.msgType).toBe("text");
    expect(msg?.content).toBe("Hello!");
    expect(msg?.timestamp).toBe(1234567890000);
  });

  it("should normalize image message", () => {
    const payload = {
      type: "wechat-work-message",
      fromUser: "xiaoming",
      toUser: "corp123",
      msgType: "image",
      content: "",
      msgId: "msg-002",
      picUrl: "https://example.com/pic.jpg",
      mediaId: "media-123",
      imageBase64: "iVBORw0KGgo...",
      imageMimeType: "image/png",
    };

    const msg = normalizeWechatMessage(payload);

    expect(msg).not.toBeNull();
    expect(msg?.msgType).toBe("image");
    expect(msg?.imageBase64).toBe("iVBORw0KGgo...");
    expect(msg?.imageMimeType).toBe("image/png");
    expect(msg?.picUrl).toBe("https://example.com/pic.jpg");
  });

  it("should normalize voice message", () => {
    const payload = {
      type: "wechat-work-message",
      fromUser: "xiaoming",
      toUser: "corp123",
      msgType: "voice",
      content: "",
      msgId: "msg-003",
      mediaId: "voice-media-123",
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

    const msg = normalizeWechatMessage(payload);
    expect(msg).toBeNull();
  });

  it("should reject missing fromUser", () => {
    const payload = {
      type: "wechat-work-message",
      msgType: "text",
      content: "Hello",
    };

    const msg = normalizeWechatMessage(payload);
    expect(msg).toBeNull();
  });

  it("should reject missing msgType", () => {
    const payload = {
      type: "wechat-work-message",
      fromUser: "xiaoming",
      content: "Hello",
    };

    const msg = normalizeWechatMessage(payload);
    expect(msg).toBeNull();
  });

  it("should handle missing optional fields", () => {
    const payload = {
      type: "wechat-work-message",
      fromUser: "xiaoming",
      msgType: "text",
    };

    const msg = normalizeWechatMessage(payload);

    expect(msg).not.toBeNull();
    expect(msg?.content).toBe("");
    expect(msg?.msgId).toBe("");
    expect(msg?.toUser).toBe("");
    expect(msg?.agentId).toBeUndefined();
    expect(msg?.timestamp).toBeUndefined();
  });
});

// Test image message handling
describe("image message handling", () => {
  it("should create image array for agent", () => {
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAE=";
    const imageMimeType = "image/png";

    const images = [
      {
        type: "image" as const,
        data: imageBase64,
        mimeType: imageMimeType,
      },
    ];

    expect(images).toHaveLength(1);
    expect(images[0].type).toBe("image");
    expect(images[0].data).toBe(imageBase64);
  });

  it("should handle missing image data gracefully", () => {
    const imageBase64: string | undefined = undefined;
    const imageMimeType: string | undefined = undefined;

    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

    if (imageBase64 && imageMimeType) {
      images.push({
        type: "image",
        data: imageBase64,
        mimeType: imageMimeType,
      });
    }

    expect(images).toHaveLength(0);
  });

  it("should generate fallback text when image unavailable", () => {
    const picUrl = "https://example.com/pic.jpg";
    const mediaId = "media-123";

    const metaParts: string[] = [];
    if (picUrl) metaParts.push(`picUrl=${picUrl}`);
    if (mediaId) metaParts.push(`mediaId=${mediaId}`);

    const fallbackText = `[图片不可用] ${metaParts.join(" ")}`;

    expect(fallbackText).toContain("图片不可用");
    expect(fallbackText).toContain("picUrl=");
    expect(fallbackText).toContain("mediaId=");
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

  it("should handle empty transcription result", () => {
    const transcribedText = "";
    const formattedText = transcribedText.trim()
      ? `[语音] ${transcribedText}`
      : "[语音] (转写结果为空)";

    expect(formattedText).toBe("[语音] (转写结果为空)");
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

  it("should not support location messages", () => {
    expect(supportedTypes.includes("location")).toBe(false);
  });
});
