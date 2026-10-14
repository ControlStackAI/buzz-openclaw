import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { buzzPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(buzzPlugin);
