import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../public/remote/sw.js", import.meta.url), "utf-8");
describe("TV offline shell", () => {
  it("never intercepts API calls, mutations, or other origins", () => {
    const address = "https://test.example";
    const context = { URL, self: { location: { href: address + "/remote/sw.js?v=build" }, addEventListener() {} } };
    const allowed = runInNewContext(source + "\nisShell", context) as (request: { url: string; method: string }, origin: string) => boolean;
    const test = (path: string, method = "GET") => allowed({ url: new URL(path, address).href, method }, address);
    expect(test("/remote/")).toBe(true);
    expect(test("/assets/remote-build.js")).toBe(true);
    expect(test("/remote/api/status")).toBe(false);
    expect(test("/remote/api/command", "POST")).toBe(false);
    expect(test("/remote/", "POST")).toBe(false);
    expect(test("https://other.example/remote/")).toBe(false);
  });
});
