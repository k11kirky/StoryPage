import { exportPreviews, extractDesignSystem, saveSelection } from "./extract";
import type { FromUi, Settings, ToUi } from "./messages";

const SETTINGS_KEY = "storypage.settings";

figma.showUI(__html__, { width: 520, height: 720, themeColors: true });

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
      case "save-selection":
        await saveSelection(message.nodeId, message.selection);
        break;
      case "export-previews": {
        figma.notify("Exporting previews of the components you chose…");
        const warnings: string[] = [];
        const previews = await exportPreviews(message.components, warnings);
        send({ type: "previews", previews, warnings });
        break;
      }
      case "select-node": {
        // Lets designers jump to a component from the picker.
        const node = await figma.getNodeByIdAsync(message.nodeId);
        if (node && "type" in node && node.type !== "DOCUMENT" && node.type !== "PAGE") {
          let page: BaseNode | null = node.parent;
          while (page && page.type !== "PAGE") page = page.parent;
          if (page) await figma.setCurrentPageAsync(page as PageNode);
          figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
          figma.currentPage.selection = [node as SceneNode];
        }
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
