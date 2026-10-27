import { describe, it, expect } from "vitest";

// logic.js builds its preset tables (CYCLE_PRESETS, NAMED_SHAPES,
// HOLIDAY_PRESETS) while it loads. A break in a helper those tables call makes
// the module throw on import, which fails every other test FILE at collection
// — and a file that fails to collect fails no test, so a mutation run scores
// that break as surviving. Importing it inside a test turns it into a failure.
describe("src/logic.js", () => {
  it("loads, and builds its preset tables", async () => {
    const logic = await import("../src/logic.js");
    expect(logic.normalizeCycle('["a","b"]')).toEqual(["a", "b"]);
    expect(logic.normalizeCycle(null)).toEqual([]);
    expect(logic.CYCLE_PRESETS.length).toBeGreaterThan(0);
    expect(logic.HOLIDAY_PRESETS.length).toBe(14);
  });
});
