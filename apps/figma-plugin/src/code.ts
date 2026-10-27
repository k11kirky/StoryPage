import { extractDesignSystem } from "./extract";
import type { FromUi, Settings, ToUi } from "./messages";

const SETTINGS_KEY = "storypage.settings";

figma.showUI(__html__, { width: 420, height: 620, themeColors: true });

const send = (message: ToUi) => figma.ui.postMessage(message);

figma.ui.onmessage = async (message: FromUi) => {
  try {
    switch (message.type) {
      case "init": {
        const settings = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Settings | undefined;
        send({ type: "settings", settings: settings ?? null, fileName: figma.root.name });
        break;
      }
      case "save-settings":
        await figma.clientStorage.setAsync(SETTINGS_KEY, message.settings);
        send({ type: "settings", settings: message.settings, fileName: figma.root.name });
        break;
      case "scan": {
        figma.notify("Reading variables, styles and components…");
        const result = await extractDesignSystem();
        send({ type: "scan-result", ...result });
        break;
      }
      case "notify":
        figma.notify(message.message, { error: message.error ?? false });
        break;
      case "close":
        figma.closePlugin();
        break;
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
