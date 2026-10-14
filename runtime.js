import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setBuzzRuntime, getRuntime: getBuzzRuntime } = createPluginRuntimeStore({
  pluginId: "buzz",
  errorMessage: "Buzz runtime not initialized",
});

export { getBuzzRuntime, setBuzzRuntime };
