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
  buildCustodyDays,
  nextTransition,
  fmtExchangeTime,
  upcomingTransitions,
  groupNotesByTransition,
  notesForTransition,
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

describe("fmtExchangeTime", () => {
  it("renders 12-hour times with the right meridiem", () => {
    expect(fmtExchangeTime("17:00")).toBe("5:00 PM");
    expect(fmtExchangeTime("09:30")).toBe("9:30 AM");
    expect(fmtExchangeTime("00:15")).toBe("12:15 AM");
    expect(fmtExchangeTime("12:00")).toBe("12:00 PM");
  });
  it("returns '' for junk rather than throwing", () => {
    for (const bad of [null, undefined, "", "noon", "25:00", "10:99"]) {
      expect(fmtExchangeTime(bad)).toBe("");
    }
  });
});

describe("buildCustodyDays", () => {
  const names = { childName: () => "Sam", parentName: (id) => (id === PA ? "Dad" : "Mom") };
  const opts = (start, end) => ({ startDate: start, endDate: end, ...names });

  it("emits one row per day in the window, inclusive", () => {
    const rows = buildCustodyDays([schedule()], [], opts("2026-01-05", "2026-01-11"));
    expect(rows).toHaveLength(7);
    expect(rows[0].day).toBe("2026-01-05");
    expect(rows[6].day).toBe("2026-01-11");
  });

  it("resolves the day before the window so the first row's flag is real", () => {
    // Mid-block start: not a handoff, even though it opens the window.
    const mid = buildCustodyDays([schedule()], [], opts("2026-01-08", "2026-01-14"));
    expect(mid[0].is_transition).toBe(0);
    // A window that opens ON a rotation boundary must still report it — the
    // handoff really is today. This is what the seed day buys us: the flag
    // reflects the rotation, not where the caller happened to start reading.
    const onBoundary = buildCustodyDays([schedule()], [], opts("2026-01-12", "2026-01-14"));
    expect(onBoundary[0].is_transition).toBe(1);
    expect(onBoundary[0].from_parent_id).toBe(PA);
  });

  it("flags the day the custodial parent changes", () => {
    const rows = buildCustodyDays([schedule()], [], opts("2026-01-06", "2026-01-18"));
    const transitions = rows.filter((r) => r.is_transition);
    expect(transitions.map((t) => t.day)).toEqual(["2026-01-12"]);
    expect(transitions[0].from_parent_id).toBe(PA);
    expect(transitions[0].parent_id).toBe(PB);
  });

  it("builds display strings the hub surfaces verbatim", () => {
    const rows = buildCustodyDays(
      [schedule({ exchange_time: "18:00" })], [], opts("2026-01-11", "2026-01-12"));
    expect(rows[0]).toMatchObject({ title: "Sam with Dad", subtitle: "With Dad", is_transition: 0 });
    expect(rows[1]).toMatchObject({ title: "Sam → Mom", subtitle: "Handoff 6:00 PM", is_transition: 1 });
  });

  it("falls back to a timeless handoff label when no exchange time is set", () => {
    const rows = buildCustodyDays([schedule()], [], opts("2026-01-12", "2026-01-12"));
    expect(rows[0].subtitle).toBe("Handoff today");
  });

  it("applies overrides and records them as the row's source", () => {
    const ov = {
      id: "ov-1", child_id: "kid-1", start_date: "2026-01-06", end_date: "2026-01-07",
      parent_id: PB, created_at: "2026-01-01T00:00:00Z",
    };
    const rows = buildCustodyDays([schedule()], [ov], opts("2026-01-06", "2026-01-10"));
    expect(rows.map((r) => r.source)).toEqual(
      ["override", "override", "schedule", "schedule", "schedule"]);
    // The override both starts and ends a handoff.
    expect(rows.filter((r) => r.is_transition).map((r) => r.day))
      .toEqual(["2026-01-06", "2026-01-08"]);
  });

  it("ignores archived schedules and other children's overrides", () => {
    expect(buildCustodyDays([schedule({ status: "archived" })], [], opts("2026-01-05", "2026-01-11")))
      .toHaveLength(0);
    const foreign = {
      id: "ov-2", child_id: "other-kid", start_date: "2026-01-06", end_date: "2026-01-07",
      parent_id: PB, created_at: "2026-01-01T00:00:00Z",
    };
    const rows = buildCustodyDays([schedule()], [foreign], opts("2026-01-06", "2026-01-10"));
    expect(rows.every((r) => r.source === "schedule")).toBe(true);
  });

  it("skips days it cannot resolve instead of writing a null parent", () => {
    const broken = schedule({ pattern: "custom", cycle: "not json" });
    expect(buildCustodyDays([broken], [], opts("2026-01-05", "2026-01-11"))).toHaveLength(0);
  });

  it("keys rows so a rebuild is idempotent", () => {
    const a = buildCustodyDays([schedule()], [], opts("2026-01-05", "2026-01-11"));
    const b = buildCustodyDays([schedule()], [], opts("2026-01-05", "2026-01-11"));
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length);
  });

  it("keeps children separate", () => {
    const two = [schedule(), schedule({ id: "sch-2", child_id: "kid-2", anchor_date: "2026-01-12" })];
    const rows = buildCustodyDays(two, [], opts("2026-01-05", "2026-01-06"));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.child_id))).toEqual(new Set(["kid-1", "kid-2"]));
  });
});

describe("nextTransition", () => {
  const days = buildCustodyDays(
    [schedule(), schedule({ id: "sch-2", child_id: "kid-2", anchor_date: "2026-01-08" })],
    [],
    { startDate: "2026-01-05", endDate: "2026-02-05", childName: () => "K", parentName: () => "P" },
  );

  it("finds the soonest handoff at or after the given date", () => {
    expect(nextTransition(days, "2026-01-06", "kid-1").day).toBe("2026-01-12");
    expect(nextTransition(days, "2026-01-12", "kid-1").day).toBe("2026-01-12"); // inclusive
    expect(nextTransition(days, "2026-01-13", "kid-1").day).toBe("2026-01-19");
  });
  it("scopes to one child when asked, and spans all children when not", () => {
    expect(nextTransition(days, "2026-01-09", "kid-2").day).toBe("2026-01-15");
    expect(nextTransition(days, "2026-01-13").day).toBe("2026-01-15"); // kid-2 comes first
  });
  it("returns null past the end of the window", () => {
    expect(nextTransition(days, "2026-03-01", "kid-1")).toBe(null);
    expect(nextTransition([], "2026-01-05")).toBe(null);
  });
});

describe("handoff notes ↔ custody transitions", () => {
  // kid-1 flips every 7 days from the Monday anchor: 01-12, 01-19, 01-26 …
  const days = buildCustodyDays([schedule({ exchange_time: "18:00" })], [],
    { startDate: "2026-01-06", endDate: "2026-02-15", childName: () => "Sam", parentName: (id) => (id === PA ? "Dad" : "Mom") });
  const note = (over = {}) => ({
    id: "n1", child_id: "kid-1", note_date: "2026-01-19", category: "items",
    body: "Cleats in the blue bag", created_by: PA, created_at: "2026-01-15T00:00:00Z", ...over,
  });

  describe("upcomingTransitions", () => {
    it("offers future handoffs, nearest first — writing ahead is the normal path", () => {
      const out = upcomingTransitions(days, "2026-01-13");
      expect(out.map(t => t.day)).toEqual(["2026-01-19", "2026-01-26", "2026-02-02", "2026-02-09"]);
      expect(out[0].subtitle).toBe("Handoff 6:00 PM");
    });
    it("includes today's handoff — a note is still useful the morning of", () => {
      expect(upcomingTransitions(days, "2026-01-19")[0].day).toBe("2026-01-19");
    });
    it("never offers a past date", () => {
      expect(upcomingTransitions(days, "2026-01-20").every(t => t.day > "2026-01-19")).toBe(true);
    });
    it("scopes to one child and honours the limit", () => {
      const two = buildCustodyDays(
        [schedule(), schedule({ id: "s2", child_id: "kid-2", anchor_date: "2026-01-08" })], [],
        { startDate: "2026-01-06", endDate: "2026-02-15", childName: () => "K", parentName: () => "P" });
      expect(upcomingTransitions(two, "2026-01-06", { childId: "kid-2" })
        .every(t => t.child_id === "kid-2")).toBe(true);
      expect(upcomingTransitions(two, "2026-01-06", { limit: 3 })).toHaveLength(3);
    });
    it("returns nothing rather than throwing when there is no schedule", () => {
      expect(upcomingTransitions([], "2026-01-13")).toEqual([]);
      expect(upcomingTransitions(undefined, "2026-01-13")).toEqual([]);
    });
  });

  describe("groupNotesByTransition", () => {
    it("files a note written ahead under its future handoff", () => {
      const { groups, unanchored } = groupNotesByTransition([note()], days, "2026-01-13");
      expect(unanchored).toEqual([]);
      expect(groups).toHaveLength(1);
      expect(groups[0].transition.day).toBe("2026-01-19");
      expect(groups[0].isUpcoming).toBe(true);
      expect(groups[0].notes).toHaveLength(1);
    });

    it("collects several notes under one handoff", () => {
      const notes = [note({ id: "a" }), note({ id: "b", category: "health" })];
      const { groups } = groupNotesByTransition(notes, days, "2026-01-13");
      expect(groups).toHaveLength(1);
      expect(groups[0].notes.map(n => n.id)).toEqual(["a", "b"]);
    });

    it("marks a past handoff as no longer upcoming", () => {
      const { groups } = groupNotesByTransition([note()], days, "2026-01-25");
      expect(groups[0].isUpcoming).toBe(false);
    });

    it("orders soonest-upcoming first, then past most-recent first", () => {
      const notes = [
        note({ id: "past",   note_date: "2026-01-12" }),
        note({ id: "far",    note_date: "2026-02-02" }),
        note({ id: "soon",   note_date: "2026-01-19" }),
        note({ id: "older",  note_date: "2026-01-05" }),
      ];
      const { groups } = groupNotesByTransition(notes, days, "2026-01-13");
      // 2026-01-05 precedes the window, so it has no transition to attach to.
      expect(groups.map(g => g.notes[0].id)).toEqual(["soon", "far", "past"]);
    });

    it("keeps a note whose handoff moved, rather than losing it", () => {
      // The append-only log must never go invisible because derived state
      // changed underneath it — this is the whole reason for the date anchor.
      const moved = groupNotesByTransition([note({ note_date: "2026-01-20" })], days, "2026-01-13");
      expect(moved.groups).toEqual([]);
      expect(moved.unanchored.map(n => n.note_date)).toEqual(["2026-01-20"]);
    });

    it("keeps notes when the schedule is archived entirely", () => {
      const { groups, unanchored } = groupNotesByTransition([note()], [], "2026-01-13");
      expect(groups).toEqual([]);
      expect(unanchored).toHaveLength(1);
    });

    it("does not attach another child's note to this child's handoff", () => {
      const { groups, unanchored } = groupNotesByTransition(
        [note({ child_id: "kid-2" })], days, "2026-01-13");
      expect(groups).toEqual([]);
      expect(unanchored).toHaveLength(1);
    });

    it("sorts unanchored notes newest first and handles empty input", () => {
      const notes = [note({ id: "old", note_date: "2026-03-01" }), note({ id: "new", note_date: "2026-03-09" })];
      const { unanchored } = groupNotesByTransition(notes, days, "2026-01-13");
      expect(unanchored.map(n => n.id)).toEqual(["new", "old"]);
      expect(groupNotesByTransition([], days, "2026-01-13")).toEqual({ groups: [], unanchored: [] });
      expect(groupNotesByTransition(undefined, undefined, "2026-01-13")).toEqual({ groups: [], unanchored: [] });
    });
  });

  describe("notesForTransition", () => {
    it("counts only this child's notes on that day", () => {
      const notes = [note(), note({ id: "n2" }), note({ id: "n3", child_id: "kid-2" }), note({ id: "n4", note_date: "2026-01-26" })];
      expect(notesForTransition(notes, "kid-1", "2026-01-19").map(n => n.id)).toEqual(["n1", "n2"]);
      expect(notesForTransition(notes, "kid-1", "2026-02-02")).toEqual([]);
      expect(notesForTransition(undefined, "kid-1", "2026-01-19")).toEqual([]);
    });
  });
});
