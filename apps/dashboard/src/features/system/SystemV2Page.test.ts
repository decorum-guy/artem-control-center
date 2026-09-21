import { describe, expect, it } from "vitest";
import { homeServerMaintenanceVisible } from "./SystemV2Page";

describe("home-server maintenance surface", () => {
  it("does not mount the production-only endpoint client in read-only or fixture runtimes", () => {
    expect(homeServerMaintenanceVisible("read_only")).toBe(false);
    expect(homeServerMaintenanceVisible("fixtures")).toBe(false);
    expect(homeServerMaintenanceVisible("integration_test")).toBe(false);
  });

  it("keeps the surface available in production", () => {
    expect(homeServerMaintenanceVisible("production")).toBe(true);
  });
});
