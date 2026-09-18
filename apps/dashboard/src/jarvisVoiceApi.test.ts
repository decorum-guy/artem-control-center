import { describe, expect, it } from "vitest";
import { parseJarvisVoiceSnapshot } from "./jarvisVoiceApi";

const valid = {
  schemaVersion: "jarvis.voice.v1", enabled: true, configured: true, health: "healthy", state: "listening", sequence: 4,
  recognizedText: null, responseText: null, safeErrorCode: null, wakeLatencyMs: 8, sttLatencyMs: null, navigation: null
};

describe("Jarvis voice state contract", () => {
  it("accepts only the bounded voice protocol", () => {
    expect(parseJarvisVoiceSnapshot(valid)?.state).toBe("listening");
    expect(parseJarvisVoiceSnapshot({ ...valid, sequence: -1 })).toBeNull();
    expect(parseJarvisVoiceSnapshot({ ...valid, state: "shell" })).toBeNull();
    expect(parseJarvisVoiceSnapshot({ ...valid, recognizedText: 42 })).toBeNull();
    expect(parseJarvisVoiceSnapshot({ ...valid, navigation: "/settings" })?.navigation).toBe("/settings");
    for (const route of ["https://example.com", "javascript:alert(1)", "/not-a-real-jarvis-route"]) {
      expect(parseJarvisVoiceSnapshot({ ...valid, navigation: route })).toBeNull();
    }
  });
});
