import { describe, expect, it } from "vitest";
import { getSpeechErrorMessage, shouldEndVoiceSession } from "./useFridayVoiceController";

describe("Friday speech recognition errors", () => {
  it("explains denied microphone permissions", () => {
    expect(getSpeechErrorMessage("not-allowed")).toContain("麦克风权限被拒绝");
    expect(getSpeechErrorMessage("service-not-allowed")).toContain("麦克风权限被拒绝");
  });

  it("explains missing audio hardware and network failures", () => {
    expect(getSpeechErrorMessage("audio-capture")).toContain("没有检测到可用的麦克风");
    expect(getSpeechErrorMessage("network")).toContain("网络连接异常");
  });

  it("provides a retry hint when no speech is detected", () => {
    expect(getSpeechErrorMessage("no-speech")).toContain("点击麦克风重新聆听");
  });

  it("falls back to keyboard input for unsupported language or unknown errors", () => {
    expect(getSpeechErrorMessage("language-not-supported")).toContain("键盘输入");
    expect(getSpeechErrorMessage("unknown")).toContain("改用键盘输入");
  });

  it("does not show an error for an intentional abort", () => {
    expect(getSpeechErrorMessage("aborted")).toBe("");
  });
});

describe("Friday voice session recovery", () => {
  it("ends the current session after terminal recognition errors", () => {
    for (const error of ["not-allowed", "service-not-allowed", "audio-capture", "network", "language-not-supported", "unknown"]) {
      expect(shouldEndVoiceSession(error)).toBe(true);
    }
  });

  it("keeps the session available for a manual retry after no-speech", () => {
    expect(shouldEndVoiceSession("no-speech")).toBe(false);
  });

  it("does not treat an intentional abort as a terminal error", () => {
    expect(shouldEndVoiceSession("aborted")).toBe(false);
    expect(shouldEndVoiceSession(undefined)).toBe(false);
  });
});
