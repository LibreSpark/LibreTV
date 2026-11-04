import { describe, expect, it } from "vitest";
import { normalizeFridayMovieId } from "./movie-detail";

describe("normalizeFridayMovieId", () => {
  it("accepts and trims string IDs", () => {
    expect(normalizeFridayMovieId("  vod_123  ")).toBe("vod_123");
    expect(normalizeFridayMovieId("A-1")).toBe("A-1");
  });

  it("converts safe integer IDs to strings", () => {
    expect(normalizeFridayMovieId(12345)).toBe("12345");
    expect(normalizeFridayMovieId(0)).toBe("0");
    expect(normalizeFridayMovieId(Number.MAX_SAFE_INTEGER)).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(normalizeFridayMovieId(Number.MIN_SAFE_INTEGER)).toBe(
      String(Number.MIN_SAFE_INTEGER),
    );
  });

  it("rejects unsafe, fractional, and non-finite numbers", () => {
    expect(normalizeFridayMovieId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(normalizeFridayMovieId(Number.MIN_SAFE_INTEGER - 1)).toBeNull();
    expect(normalizeFridayMovieId(1.5)).toBeNull();
    expect(normalizeFridayMovieId(Number.NaN)).toBeNull();
    expect(normalizeFridayMovieId(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeFridayMovieId(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("rejects empty, oversized, or malformed strings", () => {
    expect(normalizeFridayMovieId("")).toBeNull();
    expect(normalizeFridayMovieId("   ")).toBeNull();
    expect(normalizeFridayMovieId("x".repeat(31))).toBeNull();
    expect(normalizeFridayMovieId("bad/id")).toBeNull();
    expect(normalizeFridayMovieId("id with spaces")).toBeNull();
    expect(normalizeFridayMovieId("中文ID")).toBeNull();
  });

  it("rejects values outside the supported input types", () => {
    expect(normalizeFridayMovieId(null)).toBeNull();
    expect(normalizeFridayMovieId(undefined)).toBeNull();
    expect(normalizeFridayMovieId(true)).toBeNull();
    expect(normalizeFridayMovieId({ id: "123" })).toBeNull();
    expect(normalizeFridayMovieId(["123"])).toBeNull();
  });
});
