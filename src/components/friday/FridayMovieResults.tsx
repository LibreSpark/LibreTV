"use client";

import React from "react";
import type { MovieData, MovieItem } from "./FridayPanel";

export function FridayMovieResults({
  data,
  onOpen,
}: {
  data: MovieData;
  onOpen: (movie: MovieItem) => void;
}) {
function FridayMovieResults({
  data,
  onOpen,
}: {
  data: MovieData;
  onOpen: (movie: MovieItem) => void;
}) {
  const total = data.totalFound ?? data.total ?? data.results.length;

  if (!data.results.length) {
    return (
      <div className="friday-empty-result">
        没有找到相关影片，可以换个关键词试试。
      </div>
    );
  }

  return (
    <div className="friday-movie-section">
      <div className="friday-result-heading">
        <span>搜索结果 · {data.keyword}</span>
        <span className="friday-result-count">{total} 条</span>
      </div>

      <div className="friday-movie-grid">
        {data.results.map((movie, index) => {
          const key = [
            movie.sourceKey || "",
            movie.vodId ?? "",
            movie.name || "",
            movie.vodId == null ? index : "",
          ].join("-");

          return (
            <button
              type="button"
              key={key}
              className="friday-movie-card"
              onClick={() => onOpen(movie)}
            >
              <div className="friday-poster">
                {movie.pic ? (
                  <img
                    src={movie.pic}
                    alt={movie.name || "影片海报"}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}

                <div className="friday-poster-fallback">▶</div>

                {movie.remarks ? (
                  <span className="friday-poster-remark">
                    {movie.remarks}
                  </span>
                ) : null}
              </div>

              <div className="friday-movie-info">
                <div className="friday-movie-name">
                  {movie.name || "未命名影片"}
                </div>

                <div className="friday-movie-meta">
                  {[movie.year, movie.typeName, movie.area]
                    .filter(Boolean)
                    .join(" · ") || "影视资源"}
                </div>

                <div className="friday-movie-source">
                  {movie.sourceName || movie.sourceKey || "未知来源"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
}
