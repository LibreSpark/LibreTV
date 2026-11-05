"use client";

import React from "react";
import type { RefObject } from "react";
import type { MovieData, MovieItem } from "./FridayPanel";
import { FridayMovieResults } from "./FridayMovieResults";

export type FridayConversationEntry = {
  id: string;
  isUser: boolean;
  text: string;
  movies: MovieData[];
};

export function FridayConversation({
  messagesRef,
  messages,
  listening,
  busy,
  status,
  error,
  onOpenMovie,
}: {
  messagesRef: RefObject<HTMLDivElement | null>;
  messages: FridayConversationEntry[];
  listening: boolean;
  busy: boolean;
  status: string;
  error?: { message?: string } | null;
  onOpenMovie: (movie: MovieItem) => void;
}) {
  return (
    <div ref={messagesRef} className="friday-messages">
      {messages.length === 0 ? (
        <div className="friday-welcome">
          <div className="friday-welcome-kicker">YOUR AMBIENT AI</div>
          <div className="friday-welcome-title">你好，我是 Friday。</div>
          <div className="friday-welcome-text">
            {listening
              ? "我正在聆听。告诉我你想看什么电影或电视剧。"
              : "告诉我你想看什么，或者让我帮你寻找更好的影视资源。"}
          </div>
        </div>
      ) : null}

      {messages.map((message) => (
        <React.Fragment key={message.id}>
          {message.text ? (
            <div className={`friday-message ${message.isUser ? "friday-message-user" : ""}`}>
              <div className="friday-message-content">{message.text}</div>
            </div>
          ) : null}
          {message.movies.map((data) => (
            <FridayMovieResults
              key={data.searchId}
              data={data}
              onOpen={onOpenMovie}
            />
          ))}
        </React.Fragment>
      ))}

      {busy ? (
        <div className="friday-status">
          {status === "submitted"
            ? "Friday 正在接收消息…"
            : "正在为你寻找合适的影视资源…"}
        </div>
      ) : null}

      {error ? (
        <div className="friday-error">
          {error.message || "请求失败，请稍后重试。"}
        </div>
      ) : null}
    </div>
  );
}
