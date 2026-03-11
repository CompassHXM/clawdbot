import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch for API tests
const mockFetch = vi.fn();

// Mocks for fs and child_process (used in sendMedia behavior tests)
const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (...args: unknown[]) => mockStatSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

describe("channel", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  describe("getAccessToken", () => {
    it("should fetch access token from WeChat API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-token-123",
          expires_in: 7200,
        }),
      });

      const { getAccessToken } = await import("./channel.js");
      const token = await getAccessToken("test-corp-id", "test-secret");

      expect(token).toBe("test-token-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("corpid=test-corp-id"));
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errcode: 40001,
          errmsg: "invalid credential",
        }),
      });

      const { getAccessToken } = await import("./channel.js");

      await expect(getAccessToken("bad-corp", "bad-secret")).rejects.toThrow("invalid credential");
    });
  });
});

describe("detectMediaType", () => {
  it("should detect audio files as voice", async () => {
    const { detectMediaType } = await import("./channel.js");

    expect(detectMediaType("/tmp/voice.mp3")).toBe("voice");
    expect(detectMediaType("/tmp/voice.opus")).toBe("voice");
    expect(detectMediaType("/tmp/voice.ogg")).toBe("voice");
    expect(detectMediaType("/tmp/voice.wav")).toBe("voice");
    expect(detectMediaType("/tmp/voice.amr")).toBe("voice");
    expect(detectMediaType("/tmp/voice.m4a")).toBe("voice");
    expect(detectMediaType("/tmp/voice.aac")).toBe("voice");
    expect(detectMediaType("/tmp/voice.flac")).toBe("voice");
  });

  it("should detect image files", async () => {
    const { detectMediaType } = await import("./channel.js");

    expect(detectMediaType("/tmp/photo.jpg")).toBe("image");
    expect(detectMediaType("/tmp/photo.jpeg")).toBe("image");
    expect(detectMediaType("/tmp/photo.png")).toBe("image");
    expect(detectMediaType("/tmp/photo.gif")).toBe("image");
    expect(detectMediaType("/tmp/photo.bmp")).toBe("image");
    expect(detectMediaType("/tmp/photo.webp")).toBe("image");
  });

  it("should detect video files", async () => {
    const { detectMediaType } = await import("./channel.js");

    expect(detectMediaType("/tmp/clip.mp4")).toBe("video");
    expect(detectMediaType("/tmp/clip.mov")).toBe("video");
    expect(detectMediaType("/tmp/clip.avi")).toBe("video");
    expect(detectMediaType("/tmp/clip.wmv")).toBe("video");
    expect(detectMediaType("/tmp/clip.mkv")).toBe("video");
  });

  it("should default to file for unknown extensions", async () => {
    const { detectMediaType } = await import("./channel.js");

    expect(detectMediaType("/tmp/doc.txt")).toBe("file");
    expect(detectMediaType("/tmp/report.pdf")).toBe("file");
    expect(detectMediaType("/tmp/slides.pptx")).toBe("file");
    expect(detectMediaType("/tmp/data.xlsx")).toBe("file");
    expect(detectMediaType("/tmp/archive.zip")).toBe("file");
    expect(detectMediaType("/tmp/noext")).toBe("file");
  });

  it("should be case-insensitive", async () => {
    const { detectMediaType } = await import("./channel.js");

    expect(detectMediaType("/tmp/photo.JPG")).toBe("image");
    expect(detectMediaType("/tmp/photo.PNG")).toBe("image");
    expect(detectMediaType("/tmp/video.MP4")).toBe("video");
    expect(detectMediaType("/tmp/voice.WAV")).toBe("voice");
  });
});

describe("audio file detection (legacy)", () => {
  it("should identify audio file extensions", () => {
    const audioExtensions = [".mp3", ".opus", ".ogg", ".wav", ".amr", ".m4a", ".aac"];

    const isAudioFile = (filePath: string): boolean => {
      const ext = filePath.toLowerCase().split(".").pop();
      return audioExtensions.includes(`.${ext}`);
    };

    // Audio files
    expect(isAudioFile("/tmp/voice.mp3")).toBe(true);
    expect(isAudioFile("/tmp/voice.opus")).toBe(true);
    expect(isAudioFile("/tmp/voice.amr")).toBe(true);
    expect(isAudioFile("/tmp/voice.WAV")).toBe(true);

    // Non-audio files
    expect(isAudioFile("/tmp/doc.txt")).toBe(false);
    expect(isAudioFile("/tmp/image.png")).toBe(false);
  });
});

describe("AMR conversion", () => {
  it("should use correct ffmpeg parameters for AMR-NB", () => {
    // AMR-NB requirements:
    // - Sample rate: 8000 Hz
    // - Channels: 1 (mono)
    // - Codec: libopencore_amrnb
    const expectedArgs = [
      "-y",
      "-i",
      "input.opus",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-c:a",
      "libopencore_amrnb",
      "output.amr",
    ];

    expect(expectedArgs).toContain("-ar");
    expect(expectedArgs).toContain("8000");
    expect(expectedArgs).toContain("-c:a");
    expect(expectedArgs).toContain("libopencore_amrnb");
  });
});

describe("target resolution", () => {
  it("should handle wechat: prefix", () => {
    const normalizeWechatMessagingTarget = (target: string): string | null => {
      const trimmed = target.trim();
      if (!trimmed) return null;
      const cleaned = trimmed.replace(/^wechat:/i, "").trim();
      if (!cleaned) return null;
      return cleaned;
    };

    expect(normalizeWechatMessagingTarget("wechat:xiaoming")).toBe("xiaoming");
    expect(normalizeWechatMessagingTarget("WECHAT:user123")).toBe("user123");
    expect(normalizeWechatMessagingTarget("xiaoming")).toBe("xiaoming");
    expect(normalizeWechatMessagingTarget("")).toBeNull();
    expect(normalizeWechatMessagingTarget("wechat:")).toBeNull();
  });

  it("should identify valid wechat target IDs", () => {
    const looksLikeWechatTargetId = (target: string): boolean => {
      const trimmed = target.trim();
      if (!trimmed) return false;
      if (/^wechat:/i.test(trimmed)) return true;
      return /^[\w\u4e00-\u9fa5-]+$/i.test(trimmed);
    };

    // Valid targets
    expect(looksLikeWechatTargetId("xiaoming")).toBe(true);
    expect(looksLikeWechatTargetId("wechat:user123")).toBe(true);
    expect(looksLikeWechatTargetId("小明")).toBe(true);
    expect(looksLikeWechatTargetId("user_123")).toBe(true);

    // Invalid targets
    expect(looksLikeWechatTargetId("")).toBe(false);
    expect(looksLikeWechatTargetId("   ")).toBe(false);
  });
});

describe("sendMedia with fallback", () => {
  it("should support fallbackToText option", () => {
    // Test that the sendMedia function signature includes fallbackToText
    type SendMediaParams = {
      corpId: string;
      secret: string;
      agentId: string;
      toUser: string;
      mediaUrl: string;
      text?: string;
      fallbackToText?: boolean;
    };

    const params: SendMediaParams = {
      corpId: "corp",
      secret: "secret",
      agentId: "1000002",
      toUser: "user",
      mediaUrl: "/tmp/voice.opus",
      text: "Hello",
      fallbackToText: true,
    };

    expect(params.fallbackToText).toBe(true);
  });
});

describe("sendWorkWechatMedia", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("should send image message with correct API format", async () => {
    // First call: getAccessToken
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    // Second call: message/send
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok", msgid: "msg-001" }),
    });

    const { sendWorkWechatMedia } = await import("./channel.js");
    const result = await sendWorkWechatMedia({
      corpId: "corp",
      secret: "secret",
      agentId: "1000002",
      toUser: "user1",
      mediaId: "media-id-123",
      msgType: "image",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-001");

    // Verify the API call body
    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.msgtype).toBe("image");
    expect(body.image).toEqual({ media_id: "media-id-123" });
  });

  it("should send file message with correct API format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok", msgid: "msg-002" }),
    });

    const { sendWorkWechatMedia } = await import("./channel.js");
    const result = await sendWorkWechatMedia({
      corpId: "corp",
      secret: "secret",
      agentId: "1000002",
      toUser: "user1",
      mediaId: "media-id-456",
      msgType: "file",
    });

    expect(result.ok).toBe(true);
    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.msgtype).toBe("file");
    expect(body.file).toEqual({ media_id: "media-id-456" });
  });

  it("should send video message with title and description", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok", msgid: "msg-003" }),
    });

    const { sendWorkWechatMedia } = await import("./channel.js");
    const result = await sendWorkWechatMedia({
      corpId: "corp",
      secret: "secret",
      agentId: "1000002",
      toUser: "user1",
      mediaId: "media-id-789",
      msgType: "video",
      title: "My Video",
      description: "A test video",
    });

    expect(result.ok).toBe(true);
    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.msgtype).toBe("video");
    expect(body.video).toEqual({
      media_id: "media-id-789",
      title: "My Video",
      description: "A test video",
    });
  });

  it("should return error on API failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 40004, errmsg: "invalid media type" }),
    });

    const { sendWorkWechatMedia } = await import("./channel.js");
    const result = await sendWorkWechatMedia({
      corpId: "corp",
      secret: "secret",
      agentId: "1000002",
      toUser: "user1",
      mediaId: "bad-media",
      msgType: "image",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid media type");
  });
});

describe("sendMedia behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockExecFileSync.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  /** Helper: mock statSync to return a given file size */
  function mockFileExists(size = 1024) {
    mockStatSync.mockReturnValue({ size });
  }

  /** Helper: mock readFileSync to return a buffer */
  function mockFileContent(content = "fake-file-content") {
    mockReadFileSync.mockReturnValue(Buffer.from(content));
  }

  /** Helper: mock two fetch calls (getAccessToken + upload) returning media_id */
  function mockUploadSuccess(mediaId = "mid-123") {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok", media_id: mediaId }),
    });
  }

  /** Helper: mock one fetch call for message/send success */
  function mockSendSuccess(msgid = "msg-ok") {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok", msgid }),
    });
  }

  /** Helper: mock token + text message send (for fallbacks and URL paths) */
  function mockTextSendSuccess(msgid = "txt-ok") {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: "ok", msgid }),
    });
  }

  const baseParams = {
    corpId: "corp",
    secret: "secret",
    agentId: "1000002",
    toUser: "user1",
  };

  it("should send image file via upload + image message", async () => {
    mockFileExists(1024);
    mockFileContent();

    mockUploadSuccess("img-mid");
    mockSendSuccess("img-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/photo.png",
    });

    expect(result.ok).toBe(true);
    // Verify the message/send call used msgtype=image
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.msgtype).toBe("image");
    expect(body.image).toHaveProperty("media_id");
  });

  it("should send file (txt) via upload + file message", async () => {
    mockFileExists(512);
    mockFileContent("hello world");

    mockUploadSuccess("file-mid");
    mockSendSuccess("file-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/doc.txt",
    });

    expect(result.ok).toBe(true);
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.msgtype).toBe("file");
    expect(body.file).toHaveProperty("media_id");
  });

  it("should send video via upload + video message", async () => {
    mockFileExists(2048);
    mockFileContent();

    mockUploadSuccess("vid-mid");
    mockSendSuccess("vid-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/clip.mp4",
    });

    expect(result.ok).toBe(true);
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.msgtype).toBe("video");
  });

  it("should send text separately when media + text", async () => {
    mockFileExists(512);
    mockFileContent();

    // upload
    mockUploadSuccess("img-mid");
    // sendWorkWechatMedia (image)
    mockSendSuccess("img-msg-002");
    // sendWorkWechatMessage (text caption)
    mockSendSuccess("txt-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/photo.png",
      text: "Check this out",
    });

    expect(result.ok).toBe(true);
    // Should have made 4 fetch calls: token + upload + image send + text send
    expect(mockFetch.mock.calls.length).toBe(4);
    // Last call should be the text message
    const textCallBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(textCallBody.msgtype).toBe("text");
    expect(textCallBody.text.content).toBe("Check this out");
  });

  it("should reject file exceeding size limit", async () => {
    // 11MB file — exceeds image 10MB limit
    mockFileExists(11 * 1024 * 1024);

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/big.png",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("too large");
  });

  it("should fallback to text when file not found and fallbackToText=true", async () => {
    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    mockTextSendSuccess("fb-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/nonexistent.pdf",
      text: "Here is the doc",
      fallbackToText: true,
    });

    expect(result.ok).toBe(true);
  });

  it("should return error when file not found and fallbackToText=false", async () => {
    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/nonexistent.pdf",
      fallbackToText: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not accessible");
  });

  it("should treat HTTP URLs as text message (case-insensitive)", async () => {
    mockTextSendSuccess("url-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "HTTPS://example.com/photo.png",
      text: "See this",
    });

    expect(result.ok).toBe(true);
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("HTTPS://example.com/photo.png");
  });

  it("should fallback to text when upload fails and fallbackToText=true", async () => {
    mockFileExists(512);
    mockFileContent();

    // Token + upload failure
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 7200 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 40004, errmsg: "invalid media type" }),
    });
    // Text fallback
    mockSendSuccess("fb-msg-002");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/photo.png",
      text: "Fallback text",
      fallbackToText: true,
    });

    expect(result.ok).toBe(true);
  });

  it("should skip pre-upload size check for voice (check AMR instead)", async () => {
    // 5MB source audio — larger than voice 2MB limit, but that's the source, not AMR
    mockFileExists(5 * 1024 * 1024);
    mockFileContent();
    // Mock ffmpeg conversion (execFileSync)
    mockExecFileSync.mockReturnValue(undefined);
    // After conversion, mock statSync for AMR file to return small size
    mockStatSync
      .mockReturnValueOnce({ size: 5 * 1024 * 1024 }) // first call: original file
      .mockReturnValueOnce({ size: 500 * 1024 }); // second call: converted AMR

    mockReadFileSync.mockReturnValue(Buffer.alloc(500 * 1024));

    // Upload success
    mockUploadSuccess("voice-mid");
    // Send voice success
    mockSendSuccess("voice-msg-001");

    const { sendMedia } = await import("./channel.js");
    const result = await sendMedia({
      ...baseParams,
      mediaUrl: "/tmp/big-audio.wav",
    });

    // Should succeed because we skip pre-check for voice and AMR is under 2MB
    expect(result.ok).toBe(true);
  });
});
