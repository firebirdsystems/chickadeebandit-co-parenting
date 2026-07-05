import { describe, it, expect } from "vitest";
import {
  toDayNumber,
  fromDayNumber,
  daysBetween,
  addDays,
  normalizeCycle,
  custodyKeyForDate,
  baseParentForDate,
  effectiveForDate,
  assignmentsForRange,
  mergeBlocks,
  buildCalendarEvents,
  validateSwap,
} from "../src/logic.js";

const PA = "parent-a";
const PB = "parent-b";

// A Monday anchor keeps the alternating-weeks / 2-2-3 math easy to reason about.
const schedule = (over = {}) => ({
  id: "sch-1",
  child_id: "kid-1",
  pattern: "alternating_weeks",
  cycle: null,
  cycle_length: null,
  anchor_date: "2026-01-05", // Monday
  parent_a_id: PA,
  parent_b_id: PB,
  status: "active",
  ...over,
});

describe("date helpers", () => {
  it("round-trips a date through day numbers", () => {
    expect(fromDayNumber(toDayNumber("2026-07-04"))).toBe("2026-07-04");
  });
  it("daysBetween is signed", () => {
    expect(daysBetween("2026-01-01", "2026-01-08")).toBe(7);
    expect(daysBetween("2026-01-08", "2026-01-01")).toBe(-7);
  });
  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("addDays is DST-agnostic (spring-forward week stays 24h/day)", () => {
    // US DST 2026 begins Sun Mar 8. Adding 7 days must land exactly a week later.
    expect(addDays("2026-03-06", 7)).toBe("2026-03-13");
  });
});

describe("normalizeCycle", () => {
  it("parses a JSON string", () => {
    expect(normalizeCycle('["a","b","b"]')).toEqual(["a", "b", "b"]);
  });
  it("accepts an array and strips junk", () => {
    expect(normalizeCycle(["a", "x", "b", 3])).toEqual(["a", "b"]);
  });
  it("returns [] for malformed input", () => {
    expect(normalizeCycle("not json")).toEqual([]);
    expect(normalizeCycle(null)).toEqual([]);
  });
});

describe("alternating_weeks", () => {
  const s = schedule();
  it("parent A holds the anchor week (days 0-6)", () => {
    for (let d = 0; d < 7; d++) {
      expect(baseParentForDate(s, addDays(s.anchor_date, d))).toBe(PA);
    }
  });
  it("parent B holds the second week (days 7-13)", () => {
    for (let d = 7; d < 14; d++) {
      expect(baseParentForDate(s, addDays(s.anchor_date, d))).toBe(PB);
    }
  });
  it("wraps to parent A at day 14", () => {
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 14))).toBe("a");
  });
  it("works for dates before the anchor (negative offset)", () => {
    // day -1 is the last day of the prior B-week
    expect(custodyKeyForDate(s, addDays(s.anchor_date, -1))).toBe("b");
    // day -7 begins that prior B-week
    expect(custodyKeyForDate(s, addDays(s.anchor_date, -7))).toBe("b");
    // day -8 is back to an A-week
    expect(custodyKeyForDate(s, addDays(s.anchor_date, -8))).toBe("a");
  });
});

describe("two_two_three", () => {
  const s = schedule({ pattern: "two_two_three" });
  const keys = Array.from({ length: 14 }, (_, d) =>
    custodyKeyForDate(s, addDays(s.anchor_date, d))
  );
  it("follows the canonical 2-2-3 pattern over 14 days", () => {
    expect(keys).toEqual(
      ["a", "a", "b", "b", "a", "a", "a", "b", "b", "a", "a", "b", "b", "b"]
    );
  });
  it("neither parent is ever away more than 3 days running", () => {
    const twoWeeks = keys.concat(keys); // wrap-around check
    let run = 1;
    for (let i = 1; i < twoWeeks.length; i++) {
      run = twoWeeks[i] === twoWeeks[i - 1] ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(3);
    }
  });
  it("wraps cleanly at day 14", () => {
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 14))).toBe("a");
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 15))).toBe("a");
  });
});

describe("custom cycle", () => {
  const s = schedule({ pattern: "custom", cycle: '["a","a","a","b"]', cycle_length: 4 });
  it("indexes into the cycle and wraps", () => {
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 0))).toBe("a");
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 3))).toBe("b");
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 4))).toBe("a"); // wrap
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 7))).toBe("b");
  });
  it("returns null for an empty cycle", () => {
    const bad = schedule({ pattern: "custom", cycle: "[]" });
    expect(custodyKeyForDate(bad, bad.anchor_date)).toBeNull();
  });
});

describe("unknown pattern / bad config", () => {
  it("returns null key and null parent", () => {
    const s = schedule({ pattern: "nope" });
    expect(custodyKeyForDate(s, s.anchor_date)).toBeNull();
    expect(baseParentForDate(s, s.anchor_date)).toBeNull();
  });
});

describe("overrides", () => {
  const s = schedule();
  it("an override wins over the base rotation within its range", () => {
    const overrides = [
      { id: "ov1", child_id: "kid-1", start_date: "2026-01-05", end_date: "2026-01-06",
        parent_id: PB, created_at: "2026-01-01T00:00:00Z" },
    ];
    // day 0 base is A, override flips to B
    expect(effectiveForDate(s, overrides, "2026-01-05")).toMatchObject({ parent_id: PB, source: "override" });
    // day 2 is outside the override → base A
    expect(effectiveForDate(s, overrides, "2026-01-07")).toMatchObject({ parent_id: PA, source: "schedule" });
  });
  it("ignores overrides for other children", () => {
    const overrides = [
      { id: "ov1", child_id: "OTHER", start_date: "2026-01-05", end_date: "2026-01-06",
        parent_id: PB, created_at: "2026-01-01T00:00:00Z" },
    ];
    expect(effectiveForDate(s, overrides, "2026-01-05")).toMatchObject({ parent_id: PA, source: "schedule" });
  });
  it("the latest-created override wins when ranges overlap", () => {
    const overrides = [
      { id: "old", child_id: "kid-1", start_date: "2026-01-05", end_date: "2026-01-10",
        parent_id: PB, created_at: "2026-01-01T00:00:00Z" },
      { id: "new", child_id: "kid-1", start_date: "2026-01-06", end_date: "2026-01-07",
        parent_id: PA, created_at: "2026-01-02T00:00:00Z" },
    ];
    expect(effectiveForDate(s, overrides, "2026-01-06")).toMatchObject({ parent_id: PA, override_id: "new" });
    expect(effectiveForDate(s, overrides, "2026-01-08")).toMatchObject({ parent_id: PB, override_id: "old" });
  });
});

describe("assignmentsForRange", () => {
  it("produces one entry per day, inclusive of both ends", () => {
    const s = schedule();
    const rows = assignmentsForRange(s, [], "2026-01-05", "2026-01-11");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ date: "2026-01-05", parent_id: PA });
    expect(rows[6]).toMatchObject({ date: "2026-01-11", parent_id: PA });
  });
});

describe("mergeBlocks", () => {
  it("collapses consecutive same-parent days", () => {
    const s = schedule();
    const rows = assignmentsForRange(s, [], "2026-01-05", "2026-01-18"); // two full weeks
    const blocks = mergeBlocks(rows);
    expect(blocks).toEqual([
      { start: "2026-01-05", end: "2026-01-11", parent_id: PA },
      { start: "2026-01-12", end: "2026-01-18", parent_id: PB },
    ]);
  });
  it("splits a block where an override interrupts it", () => {
    const s = schedule();
    const overrides = [
      { id: "ov", child_id: "kid-1", start_date: "2026-01-07", end_date: "2026-01-07",
        parent_id: PB, created_at: "2026-01-01T00:00:00Z" },
    ];
    const blocks = mergeBlocks(assignmentsForRange(s, overrides, "2026-01-05", "2026-01-11"));
    expect(blocks).toEqual([
      { start: "2026-01-05", end: "2026-01-06", parent_id: PA },
      { start: "2026-01-07", end: "2026-01-07", parent_id: PB },
      { start: "2026-01-08", end: "2026-01-11", parent_id: PA },
    ]);
  });
});

describe("buildCalendarEvents", () => {
  const s = schedule();
  const names = { [PA]: "Dad", [PB]: "Mom", "kid-1": "Sam" };
  const opts = {
    startDate: "2026-01-05",
    endDate: "2026-01-18",
    childName: (id) => names[id] ?? id,
    parentName: (id) => names[id] ?? id,
  };
  it("emits all-day blocks with exclusive end and a readable title", () => {
    const events = buildCalendarEvents([s], [], opts);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      title: "Sam with Dad",
      start: "2026-01-05",
      end: "2026-01-12", // exclusive: day after 2026-01-11
      all_day: true,
      source_label: "Co-Parenting",
    });
    expect(events[1]).toMatchObject({ title: "Sam with Mom", start: "2026-01-12", end: "2026-01-19" });
  });
  it("skips inactive schedules", () => {
    expect(buildCalendarEvents([schedule({ status: "archived" })], [], opts)).toEqual([]);
  });
  it("covers multiple children independently", () => {
    const s2 = schedule({ id: "sch-2", child_id: "kid-2", pattern: "two_two_three" });
    const events = buildCalendarEvents([s, s2], [], {
      ...opts,
      childName: (id) => (id === "kid-2" ? "Max" : names[id] ?? id),
    });
    expect(events.some((e) => e.title.startsWith("Max"))).toBe(true);
    expect(events.some((e) => e.title.startsWith("Sam"))).toBe(true);
  });
});

describe("validateSwap", () => {
  const base = {
    requester_id: PA, responder_id: PB, child_id: "kid-1",
    start_date: "2026-07-10", end_date: "2026-07-12", to_parent_id: PA,
  };
  const today = "2026-07-04";
  it("accepts a well-formed future swap", () => {
    expect(validateSwap(base, today)).toEqual({ ok: true });
  });
  it("rejects a reversed date range", () => {
    expect(validateSwap({ ...base, start_date: "2026-07-12", end_date: "2026-07-10" }, today).ok).toBe(false);
  });
  it("rejects a start date in the past", () => {
    expect(validateSwap({ ...base, start_date: "2026-07-01", end_date: "2026-07-02" }, today).ok).toBe(false);
  });
  it("rejects a missing child or parent", () => {
    expect(validateSwap({ ...base, child_id: "" }, today).ok).toBe(false);
    expect(validateSwap({ ...base, to_parent_id: "" }, today).ok).toBe(false);
  });
  it("rejects same requester and responder", () => {
    expect(validateSwap({ ...base, responder_id: PA }, today).ok).toBe(false);
  });
});
