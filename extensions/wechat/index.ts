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
    
    // Register HTTP handler for incoming webhooks
    api.registerHttpHandler({
      path: "/wechat-webhook",
      handler: handleWechatWebhookRequest,
    });
  },
};

export default plugin;
