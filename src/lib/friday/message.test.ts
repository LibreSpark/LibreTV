import { describe, expect, it } from "vitest";
import { getPartText } from "./message";

describe("Friday message parsing", () => {
  it("joins text parts", () => {
    const message = { id: "1", role: "assistant", parts: [{ type: "text", text: "hello" }, { type: "text", text: "Friday" }] };
    expect(getPartText(message)).toBe("helloFriday");
  });
});
