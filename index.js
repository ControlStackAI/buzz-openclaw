import { setBuzzRuntime } from "./runtime.js";
import { buzzPlugin } from "./src/channel.js";

const plugin = {
  id: "buzz",
  name: "Buzz",
  description: "Buzz channel plugin — native Nostr (NIP-01/42/29 kind:9) against the self-hosted Buzz relay",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    setBuzzRuntime(api.runtime);
    api.registerChannel({ plugin: buzzPlugin });
  },
};

export default plugin;
