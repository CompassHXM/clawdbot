import type { IncomingMessage, ServerResponse } from "node:http";

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { wechatPlugin } from "./src/channel.js";
import { setWechatRuntime } from "./src/runtime.js";
import { handleWechatWebhookRequest } from "./src/monitor.js";

const plugin = {
  id: "wechat",
  name: "WeChat",
  description: "WeChat Work (企业微信) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setWechatRuntime(api.runtime);
    api.registerChannel({ plugin: wechatPlugin });
    
    // Register HTTP route for incoming webhooks
    // Adapter: handleWechatWebhookRequest returns boolean, but registerHttpRoute expects void
    api.registerHttpRoute({
      path: "/wechat-webhook",
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        await handleWechatWebhookRequest(req, res);
      },
    });
  },
};

export default plugin;
