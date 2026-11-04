import { describe, expect, it } from "vitest";
import { normalizeFridayMovieId } from "./movie-detail";

describe("normalizeFridayMovieId", () => {
  it("accepts string IDs", () => {
    expect(normalizeFridayMovieId("  vod_123  ")).toBe("vod_123");
  });

  it("converts safe integer IDs to strings", () => {
    expect(normalizeFridayMovieId(12345)).toBe("12345");
  });

  it("rejects unsafe and malformed IDs", () => {
    expect(normalizeFridayMovieId(1.5)).toBeNull();
    expect(normalizeFridayMovieId("bad/id")).toBeNull();
    expect(normalizeFridayMovieId("x".repeat(31))).toBeNull();
  });
});
