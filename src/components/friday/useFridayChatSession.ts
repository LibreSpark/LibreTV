"use client";

import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { MessageLike } from "@/components/friday/FridayPanel";
import type { FridaySourceConfig } from "@/components/friday/useFridaySources";

type FridayChatSessionOptions = {
  sources: FridaySourceConfig[];
  filterAdult: boolean;
};

/** Owns Friday's AI SDK transport and chat session state. */
export function useFridayChatSession({
  sources,
  filterAdult,
}: FridayChatSessionOptions) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { sources, filterAdult },
      }),
    [sources, filterAdult],
  );

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
  } = useChat({
    transport,
    onError: (chatError) => {
      console.error("[Friday] Chat error:", chatError);
    },
  });

  return {
    typedMessages: messages as unknown as MessageLike[],
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    busy: status === "submitted" || status === "streaming",
  };
}
