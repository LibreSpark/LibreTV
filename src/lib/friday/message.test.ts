import { describe, expect, it } from "vitest";
import { getMovieDataForMessage, getPartText } from "./message";

describe("Friday message parsing", () => {
  it("joins text parts", () => {
    const message = { id: "1", role: "assistant", parts: [{ type: "text", text: "hello" }, { type: "text", text: "Friday" }] };
    expect(getPartText(message)).toBe("helloFriday");
  });

  it("returns empty text for messages without parts", () => {
    expect(getPartText({ id: "2", role: "assistant" })).toBe("");
  });

  it("returns no movie cards when message parts are absent", () => {
    expect(getMovieDataForMessage({ id: "3", role: "assistant" })).toEqual([]);
  });

  it("deduplicates movie search results by search ID", () => {
    const data = { searchId: "search-1", keyword: "test", results: [{ name: "movie" }] };
    const message = { id: "4", role: "assistant", parts: [{ type: "data-movies", data }, { type: "data-movies", data }] };
    expect(getMovieDataForMessage(message)).toHaveLength(1);
  });
});
