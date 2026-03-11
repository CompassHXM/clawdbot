import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wechatPlugin } from "./src/channel.js";
import { handleWechatWebhookRequest } from "./src/monitor.js";
import { setWechatRuntime } from "./src/runtime.js";

const plugin = {
  id: "wechat",
  name: "WeChat",
  description: "WeChat Work (企业微信) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWechatRuntime(api.runtime);
    api.registerChannel({ plugin: wechatPlugin });

    // Register HTTP route for incoming webhooks
    // auth: "gateway" = Gateway 令牌认证, "plugin" = 插件自行认证 (仅此两个合法值)
    // 企业微信回调使用自己的签名验证 (monitor.ts), 所以用 "plugin"
    api.registerHttpRoute({
      path: "/wechat-webhook",
      auth: "plugin",
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        await handleWechatWebhookRequest(req, res);
      },
    });
  },
};

export default plugin;
