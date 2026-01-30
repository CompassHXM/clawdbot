import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWechatRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getWechatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeChat runtime not initialized");
  }
  return runtime;
}
