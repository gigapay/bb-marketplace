import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type TabRequest = Parameters<
  PluginBrowserBbSdk["experimental_desktopBrowsers"]["captureTab"]
>[0];

// The toolbar slot only knows the thread and tab ids, while captureTab also
// needs the desktop host, window instance and connection generation. Desktop
// windows are few, so scanning them is cheap.
async function findTab(
  sdk: PluginBrowserBbSdk,
  threadId: string,
  tabId: string,
): Promise<TabRequest> {
  const browsers = sdk.experimental_desktopBrowsers;
  const hosts = await sdk.hosts.list();
  for (const host of hosts) {
    const { instances } = await browsers
      .listInstances({ hostId: host.id })
      .catch(() => ({ instances: [] }));
    for (const instance of instances) {
      const scope = {
        hostId: host.id,
        instanceId: instance.instanceId,
        generation: instance.generation,
        threadId,
      };
      const { tabs } = await browsers
        .listTabs(scope)
        .catch(() => ({ tabs: [] }));
      if (tabs.some((tab) => tab.tabId === tabId)) return { ...scope, tabId };
    }
  }
  throw new Error("This Browser tab is not open in a connected desktop window");
}

const scopeCache = new Map<string, TabRequest>();

/** Captures the visible viewport of a desktop Browser tab as a data URL. */
export async function captureBrowserTab(
  sdk: PluginBrowserBbSdk,
  threadId: string,
  tabId: string,
): Promise<string> {
  const key = `${threadId}:${tabId}`;
  const browsers = sdk.experimental_desktopBrowsers;
  const cached = scopeCache.get(key);
  if (cached !== undefined) {
    try {
      const capture = await browsers.captureTab(cached);
      return `data:${capture.mimeType};base64,${capture.base64}`;
    } catch {
      // The window reconnected under a new generation; look the tab up again.
      scopeCache.delete(key);
    }
  }
  const request = await findTab(sdk, threadId, tabId);
  const capture = await browsers.captureTab(request);
  scopeCache.set(key, request);
  return `data:${capture.mimeType};base64,${capture.base64}`;
}
