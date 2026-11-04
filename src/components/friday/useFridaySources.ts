"use client";

import { useMemo } from "react";
import {
  useAppStore,
  resolveSource,
  isSourceDisabled,
  isInDisabledSubscription,
} from "@/lib/store";

export type FridaySourceConfig = {
  key: string;
  name: string;
  url: string;
  detail?: string;
  isAdult?: boolean;
  [key: string]: unknown;
};

/**
 * Resolves the enabled video sources and adult-content filter used by Friday.
 * Explicit props take precedence over the user's current app-store settings.
 */
export function useFridaySources(
  sources?: FridaySourceConfig[],
  filterAdult?: boolean,
) {
  const appStore = useAppStore();

  const storeSources = useMemo<FridaySourceConfig[]>(() => {
    const selectedKeys = Array.isArray(appStore.selectedKeys)
      ? appStore.selectedKeys
      : [];

    const result: FridaySourceConfig[] = [];

    for (const key of selectedKeys) {
      if (!key) continue;
      if (isSourceDisabled(appStore, key)) continue;
      if (isInDisabledSubscription(appStore, key)) continue;

      const source = resolveSource(appStore, key);

      if (source) {
        result.push(source as FridaySourceConfig);
      }
    }

    return result;
  }, [
    appStore.selectedKeys,
    appStore.customAPIs,
    appStore.envSources,
    appStore.sourceHealth,
    appStore.subscriptions,
  ]);

  return {
    activeSources: sources ?? storeSources,
    activeFilterAdult: filterAdult ?? Boolean(appStore.yellowFilter),
  };
}
