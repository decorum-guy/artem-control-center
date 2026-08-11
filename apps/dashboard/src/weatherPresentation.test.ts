import { describe, expect, it } from "vitest";
import { weatherKind, weatherLabel } from "./weatherPresentation";

describe("weather presentation", () => {
  it("maps WMO conditions into stable visual families", () => {
    expect(weatherKind(0)).toBe("clear");
    expect(weatherKind(2)).toBe("partly");
    expect(weatherKind(45)).toBe("fog");
    expect(weatherKind(61)).toBe("rain");
    expect(weatherKind(73)).toBe("snow");
    expect(weatherKind(95)).toBe("storm");
  });

  it("uses concise Russian labels", () => {
    expect(weatherLabel(0)).toBe("Ясно");
    expect(weatherLabel(61)).toBe("Дождь");
    expect(weatherLabel(95)).toBe("Гроза");
  });
});
