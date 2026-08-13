import { describe, it, expect } from "vitest";
import {
  compileCycle,
  mergeScheduleVersion,
  agreedVersion,
  openAmendment,
  amendmentStance,
  canSignAmendment,
  scheduleNoticeAudience,
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
  notesForTransition, searchableFields, describeScheduleChange,
  draftProposalTerms, draftSendBlocker,
  soleCoParentCandidate, lockedSwapOverrides, mergeSwapRecord, canMemberAgreeToSwap,
  pairingState, partitionMessagesBySession,
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

describe("alternating_weekends", () => {
  const s = schedule({ pattern: "alternating_weekends" });
  const keys = Array.from({ length: 14 }, (_, d) =>
    custodyKeyForDate(s, addDays(s.anchor_date, d))
  );

  it("gives parent B Friday through Sunday of the first week only", () => {
    expect(keys).toEqual([
      "a", "a", "a", "a", "b", "b", "b",
      "a", "a", "a", "a", "a", "a", "a",
    ]);
  });

  it("lands parent B's block on an actual Fri/Sat/Sun", () => {
    // The anchor is a Monday, so the pattern's weekday alignment is real and
    // not just an index coincidence — this is the assumption anchorHint states.
    for (const d of [4, 5, 6]) {
      const date = new Date(`${addDays(s.anchor_date, d)}T00:00:00Z`);
      expect([5, 6, 0]).toContain(date.getUTCDay());
      expect(custodyKeyForDate(s, addDays(s.anchor_date, d))).toBe("b");
    }
  });

  it("skips the intervening weekend, so B gets every OTHER weekend", () => {
    for (const d of [11, 12, 13]) {
      expect(custodyKeyForDate(s, addDays(s.anchor_date, d))).toBe("a");
    }
    // ...and B's next weekend is exactly 14 days after the first.
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 18))).toBe("b");
  });

  it("wraps cleanly at day 14 and resolves before the anchor", () => {
    expect(custodyKeyForDate(s, addDays(s.anchor_date, 14))).toBe("a");
    // The week immediately before the anchor is the off week, so the Friday
    // three days back is still A's; B's previous weekend is a week earlier.
    expect(custodyKeyForDate(s, addDays(s.anchor_date, -3))).toBe("a");
    expect(custodyKeyForDate(s, addDays(s.anchor_date, -10))).toBe("b"); // prior Fri
    expect(custodyKeyForDate(s, addDays(s.anchor_date, -7))).toBe("a");
  });

  it("produces two transitions per fortnight in the materialized days", () => {
    const rows = buildCustodyDays([s], [], {
      startDate: s.anchor_date,
      endDate: addDays(s.anchor_date, 13),
    });
    const transitions = rows.filter((r) => r.is_transition).map((r) => r.day);
    // Handoff to B on the Friday, back to A on the Monday.
    expect(transitions).toEqual([addDays(s.anchor_date, 4), addDays(s.anchor_date, 7)]);
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

describe("lockedSwapOverrides", () => {
  const swap = (over = {}) => ({
    id: "sw-1", child_id: "kid-1", start_date: "2026-01-05", end_date: "2026-01-06",
    to_parent_id: PB, status: "locked", locked_at: "2026-01-02T00:00:00Z", ...over,
  });

  it("a locked swap is the only thing that moves a day off the rotation", () => {
    const s = schedule();
    const derived = lockedSwapOverrides([
      swap(),
      swap({ id: "sw-2", status: "pending", locked_at: null }),
      swap({ id: "sw-3", status: "declined" }),
      swap({ id: "sw-4", status: "cancelled" }),
    ]);
    expect(derived.map((o) => o.id)).toEqual(["sw-1"]);
    expect(effectiveForDate(s, derived, "2026-01-05"))
      .toMatchObject({ parent_id: PB, source: "override", override_id: "sw-1" });
    expect(effectiveForDate(s, derived, "2026-01-07"))
      .toMatchObject({ parent_id: PA, source: "schedule" });
  });

  it("a locked row with no snapshot terms produces nothing, not a wrong day", () => {
    // A row tampered term-less (or locked before the snapshot existed) must
    // fall back to the base rotation rather than invent an exception.
    expect(lockedSwapOverrides([swap({ start_date: null })])).toEqual([]);
    expect(lockedSwapOverrides([swap({ to_parent_id: null })])).toEqual([]);
    expect(lockedSwapOverrides([swap({ child_id: null })])).toEqual([]);
  });

  it("of two locked swaps covering the same day, the later countersign wins", () => {
    const s = schedule();
    const derived = lockedSwapOverrides([
      swap({ id: "first", end_date: "2026-01-10", locked_at: "2026-01-01T00:00:00Z" }),
      swap({ id: "second", start_date: "2026-01-06", end_date: "2026-01-07",
             to_parent_id: PA, locked_at: "2026-01-02T00:00:00Z" }),
    ]);
    expect(effectiveForDate(s, derived, "2026-01-06")).toMatchObject({ parent_id: PA, override_id: "second" });
    expect(effectiveForDate(s, derived, "2026-01-08")).toMatchObject({ parent_id: PB, override_id: "first" });
  });
});

describe("mergeSwapRecord", () => {
  const request = {
    id: "sw-1", requester_id: PA, responder_id: PB,
    child_id: "mutable-kid", start_date: "2026-02-01", end_date: "2026-02-02",
    to_parent_id: PA, note: "mutable", status: "cancelled",
    created_at: "2026-01-01T00:00:00Z",
  };
  const agreement = {
    id: "sw-1", requester_id: PA, responder_id: PB, status: "locked",
    child_id: "frozen-kid", start_date: "2026-03-01", end_date: "2026-03-02",
    to_parent_id: PB, note: "frozen", locked_at: "2026-01-03T00:00:00Z",
    requester_agreed: 1, responder_agreed: 1,
  };

  it("uses only frozen agreement terms after lock", () => {
    expect(mergeSwapRecord(request, agreement)).toMatchObject({
      status: "locked", child_id: "frozen-kid", start_date: "2026-03-01",
      end_date: "2026-03-02", to_parent_id: PB, note: "frozen",
    });
  });

  it("keeps a locked agreement when its request was deleted", () => {
    expect(mergeSwapRecord({ id: "sw-1" }, agreement)).toMatchObject({
      id: "sw-1", status: "locked", child_id: "frozen-kid",
      requester_id: PA, responder_id: PB,
    });
  });

  it("does not fall back to mutable terms for an incomplete snapshot", () => {
    expect(mergeSwapRecord(request, { ...agreement, child_id: null }).child_id).toBeNull();
  });

  it("shows the first party's frozen terms while the agreement is still pending", () => {
    const pending = { ...agreement, status: "pending", responder_agreed: 0, locked_at: null };
    expect(mergeSwapRecord({ ...request, status: "pending" }, pending)).toMatchObject({
      status: "pending", child_id: "frozen-kid", start_date: "2026-03-01",
      end_date: "2026-03-02", to_parent_id: PB, note: "frozen",
    });
  });

  it("lets either party recover when their durable agreement flag is missing", () => {
    const pending = { ...request, status: "pending", requester_agreed: 0, responder_agreed: 0 };
    expect(canMemberAgreeToSwap(pending, PA)).toBe(true);
    expect(canMemberAgreeToSwap(pending, PB)).toBe(true);
    expect(canMemberAgreeToSwap({ ...pending, requester_agreed: 1 }, PA)).toBe(false);
    expect(canMemberAgreeToSwap({ ...pending, status: "cancelled" }, PB)).toBe(false);
  });

  it("treats the endpoint-only terminal status as authoritative", () => {
    expect(mergeSwapRecord(
      { ...request, status: "pending" },
      { ...agreement, status: "declined", responder_agreed: 0, locked_at: null },
    ).status).toBe("declined");
  });

  it("keeps frozen terms after cancellation clears the last consent flag", () => {
    expect(mergeSwapRecord(
      { ...request, child_id: "tampered-kid", start_date: "2026-04-01" },
      {
        ...agreement, status: "cancelled", requester_agreed: 0,
        responder_agreed: 0, locked_at: null,
      },
    )).toMatchObject({
      status: "cancelled", child_id: "frozen-kid", start_date: "2026-03-01",
      end_date: "2026-03-02", to_parent_id: PB, note: "frozen",
    });
  });

  it("renders a cancelled agreement snapshot after its request was deleted", () => {
    expect(mergeSwapRecord(
      { id: "sw-1" },
      {
        ...agreement, status: "cancelled", requester_agreed: 0,
        responder_agreed: 0, locked_at: null,
      },
    )).toMatchObject({
      status: "cancelled", child_id: "frozen-kid", start_date: "2026-03-01",
      end_date: "2026-03-02", to_parent_id: PB,
    });
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

describe("soleCoParentCandidate", () => {
  const adult = (id, over = {}) => ({ id, name: id, role: "adult", hasLogin: true, ...over });

  it("picks the only other adult", () => {
    expect(soleCoParentCandidate([adult("me"), adult("them")], "me")?.id).toBe("them");
  });

  it("declines to guess once a third adult is present", () => {
    // A new spouse in the space. Picking wrong here would open the private
    // message log to the wrong person, so the user chooses explicitly.
    const roster = [adult("me"), adult("other-parent"), adult("stepparent")];
    expect(soleCoParentCandidate(roster, "me")).toBeNull();
  });

  it("ignores adults who have no login and so could never pair back", () => {
    const roster = [adult("me"), adult("them"), adult("placeholder", { hasLogin: false })];
    expect(soleCoParentCandidate(roster, "me")?.id).toBe("them");
  });

  it("treats a missing hasLogin as present, since the field is optional", () => {
    const roster = [adult("me"), { id: "them", name: "Them", role: "adult" }];
    expect(soleCoParentCandidate(roster, "me")?.id).toBe("them");
  });

  it("returns null when there is nobody else, or no caller", () => {
    expect(soleCoParentCandidate([adult("me")], "me")).toBeNull();
    expect(soleCoParentCandidate([adult("me"), adult("them")], undefined)).toBeNull();
    expect(soleCoParentCandidate(undefined, "me")).toBeNull();
  });
});

describe("private schedule drafts", () => {
  // A draft carries the same fields a proposal does, minus everything about a
  // second party — it has none until it is sent.
  const draft = (over = {}) => ({
    id: "draft-1",
    author_id: PA,
    child_id: "kid-1",
    parent_a_id: PA,
    parent_b_id: PB,
    pattern: "alternating_weeks",
    cycle: JSON.stringify(compileCycle("alternating_weeks")),
    cycle_length: 14,
    anchor_date: "2026-01-05",
    exchange_time: "17:00",
    timezone: "America/Denver",
    rationale: null,
    base_version_id: null,
    ...over,
  });

  describe("draftProposalTerms", () => {
    it("produces exactly the shape /api/propose-agreement takes", () => {
      expect(draftProposalTerms(draft(), "UTC")).toEqual({
        child_id: "kid-1",
        parent_a_id: PA,
        parent_b_id: PB,
        pattern: "alternating_weeks",
        cycle: JSON.stringify(compileCycle("alternating_weeks")),
        cycle_length: 14,
        anchor_date: "2026-01-05",
        exchange_time: "17:00",
        timezone: "America/Denver",
        effective_from: null,
        effective_to: null,
        rationale: null,
        base_version_id: null,
      });
    });

    it("falls back to the space timezone, so a draft never proposes a null zone", () => {
      expect(draftProposalTerms(draft({ timezone: null }), "America/Chicago").timezone)
        .toBe("America/Chicago");
    });

    it("refuses a half-finished draft instead of proposing the gaps", () => {
      // Saving an incomplete draft is the POINT of a draft. Turning one into a
      // proposal is what must not happen by accident.
      expect(draftProposalTerms(draft({ anchor_date: null }), "UTC")).toBeNull();
      expect(draftProposalTerms(draft({ pattern: null }), "UTC")).toBeNull();
      expect(draftProposalTerms(draft({ cycle: "[]", cycle_length: 0 }), "UTC")).toBeNull();
      expect(draftProposalTerms(draft({ timezone: null }), null)).toBeNull();
    });

    it("refuses a draft naming one person as both parents", () => {
      expect(draftProposalTerms(draft({ parent_b_id: PA }), "UTC")).toBeNull();
    });

    it("carries the COMPILED cycle, not the pattern name", () => {
      // What gets countersigned is the day-by-day array. If a draft stored only
      // the pattern name, a later release redefining that pattern would change
      // what a saved draft proposes, silently.
      const terms = draftProposalTerms(draft({ pattern: "two_two_three",
        cycle: JSON.stringify(compileCycle("two_two_three")) }), "UTC");
      expect(JSON.parse(terms.cycle)).toEqual(compileCycle("two_two_three"));
      expect(terms.cycle_length).toBe(compileCycle("two_two_three").length);
    });
  });

  describe("draftSendBlocker", () => {
    it("lets a complete first-schedule draft through", () => {
      expect(draftSendBlocker(draft(), null, "UTC")).toBeNull();
    });

    it("blocks a half-finished draft with something a person can act on", () => {
      expect(draftSendBlocker(draft({ anchor_date: null }), null, "UTC"))
        .toMatch(/missing something/i);
    });

    it("blocks a draft that would silently revert the other parent's change", () => {
      // Written against nothing; a version has since been countersigned. Sending
      // as-is proposes undoing it while looking like an ordinary edit.
      const agreed = schedule({ id: "ver-2", status: "agreed" });
      expect(draftSendBlocker(draft({ base_version_id: null }), agreed, "UTC"))
        .toMatch(/changed after you started/i);
    });

    it("blocks a draft whose base version is no longer the one in force", () => {
      const agreed = schedule({ id: "ver-3", status: "agreed" });
      expect(draftSendBlocker(draft({ base_version_id: "ver-1" }), agreed, "UTC"))
        .toMatch(/changed after you started/i);
    });

    it("lets a draft through once it is based on what is actually in force", () => {
      const agreed = schedule({ id: "ver-3", status: "agreed", pattern: "two_two_three" });
      expect(draftSendBlocker(
        draft({ base_version_id: "ver-3" }), agreed, "UTC",
      )).toBeNull();
    });

    it("refuses a draft identical to the schedule already in force", () => {
      // The other parent must never be asked to countersign a change that
      // changes nothing.
      const agreed = schedule({
        id: "ver-3", status: "agreed",
        cycle: JSON.stringify(compileCycle("alternating_weeks")), cycle_length: 14,
        exchange_time: "17:00", timezone: "America/Denver",
      });
      expect(draftSendBlocker(draft({ base_version_id: "ver-3" }), agreed, "UTC"))
        .toMatch(/nothing to propose/i);
    });

    it("says so plainly when there is no draft at all", () => {
      expect(draftSendBlocker(null, null, "UTC")).toBeTruthy();
    });
  });
});

describe("describeScheduleChange", () => {
  const before = schedule();

  it("returns null when nothing changed, so a no-op save stays silent", () => {
    expect(describeScheduleChange(before, { ...before })).toBeNull();
  });

  it("returns null for a brand-new schedule (no prior version)", () => {
    expect(describeScheduleChange(null, { ...before })).toBeNull();
  });

  it("names a single changed field", () => {
    expect(describeScheduleChange(before, { ...before, anchor_date: "2026-01-12" }))
      .toBe("the cycle start date");
  });

  it("joins several changes the way a person would", () => {
    expect(describeScheduleChange(before, {
      ...before, pattern: "two_two_three", anchor_date: "2026-01-12", exchange_time: "17:00",
    })).toBe("the rotation pattern, the cycle start date and the exchange time");
  });

  it("treats swapping the two parents as a change", () => {
    expect(describeScheduleChange(before, { ...before, parent_a_id: PB, parent_b_id: PA }))
      .toBe("which parent is Parent A and which parent is Parent B");
  });

  it("does not double-report a custom cycle via cycle_length", () => {
    // cycle_length is derived from cycle; listing both would say the same thing
    // twice on every custom-cycle edit.
    expect(describeScheduleChange(
      { ...before, cycle: '["a","b"]', cycle_length: 2 },
      { ...before, cycle: '["a","a","b"]', cycle_length: 3 },
    )).toBe("the custom cycle");
  });

  it("treats null and undefined as the same absent value", () => {
    expect(describeScheduleChange(
      { ...before, exchange_time: null },
      { ...before, exchange_time: undefined },
    )).toBeNull();
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

describe("searchableFields", () => {
  it("matches on the message body and its author", () => {
    const fields = searchableFields({ body: "swapping the Tuesday pickup" }, "Sam");
    expect(fields).toContain("swapping the Tuesday pickup");
    expect(fields).toContain("Sam");
  });
});

describe("pairingState", () => {
  it("is unpaired with no partner, and active once both have named each other", () => {
    expect(pairingState({ partnerId: null, reciprocal: false, proposalPending: false })).toBe("unpaired");
    expect(pairingState({ partnerId: PB, reciprocal: true, proposalPending: false })).toBe("active");
  });

  it("is awaiting while the hub reports the caller's own proposal live", () => {
    // Includes a RE-proposal to a former co-parent: message history with them
    // must not read as "ended" when the invitation on the table is new.
    expect(pairingState({ partnerId: PB, reciprocal: false, proposalPending: true })).toBe("awaiting");
  });

  it("is ended — not awaiting — when the other side tore the pairing down", () => {
    // The difference the parent feels: "they'll confirm any moment" versus
    // "this is over". The hub clears the survivor's session on unpair, so this
    // is reported even for a pairing that never exchanged a message.
    expect(pairingState({ partnerId: PB, reciprocal: false, proposalPending: false })).toBe("ended");
  });
});

describe("partitionMessagesBySession", () => {
  const msg = (over = {}) => ({
    id: "m", author_id: PA, recipient_id: PB, body: "hi", sent_at: "2026-01-01T00:00:00Z", ...over,
  });

  it("keeps the current session's messages in the live thread", () => {
    const { current, earlier } = partitionMessagesBySession(
      [msg({ id: "m1", session_id: "s2" })], PA, "s2",
    );
    expect(current.map(m => m.id)).toEqual(["m1"]);
    expect(earlier).toEqual([]);
  });

  it("separates an ended pairing's record from the current one", () => {
    const rows = [
      msg({ id: "old", recipient_id: "ex", session_id: "s1", sent_at: "2025-01-01T00:00:00Z" }),
      msg({ id: "new", session_id: "s2", sent_at: "2026-01-01T00:00:00Z" }),
    ];
    const { current, earlier } = partitionMessagesBySession(rows, PA, "s2");
    expect(current.map(m => m.id)).toEqual(["new"]);
    expect(earlier).toHaveLength(1);
    expect(earlier[0].counterpartId).toBe("ex");
    expect(earlier[0].messages.map(m => m.id)).toEqual(["old"]);
  });

  it("files everything as earlier while there is no live session", () => {
    // Awaiting / ended / unpaired all read back a null session, so the record
    // of the pairing that just ended sits under its own heading, never in a
    // live thread whose composer cannot work.
    const { current, earlier } = partitionMessagesBySession(
      [msg({ id: "old", session_id: "s1" })], PA, null,
    );
    expect(current).toEqual([]);
    expect(earlier[0].counterpartId).toBe(PB);
  });

  it("keeps one person's history contiguous across their own past sessions", () => {
    // The same couple, split and re-paired: their earlier sessions are one
    // group, not one archive block per session.
    const rows = [
      msg({ id: "a", session_id: "s1", sent_at: "2024-01-01T00:00:00Z" }),
      msg({ id: "b", session_id: "s2", sent_at: "2025-01-01T00:00:00Z" }),
      msg({ id: "c", session_id: "s3", sent_at: "2026-01-01T00:00:00Z" }),
    ];
    const { current, earlier } = partitionMessagesBySession(rows, PA, "s3");
    expect(current.map(m => m.id)).toEqual(["c"]);
    expect(earlier).toHaveLength(1);
    expect(earlier[0].counterpartId).toBe(PB);
    expect(earlier[0].messages.map(m => m.id)).toEqual(["a", "b"]);
  });

  it("groups each former co-parent separately, most recent first", () => {
    const rows = [
      msg({ id: "a", recipient_id: "ex1", session_id: "s1", sent_at: "2024-01-01T00:00:00Z" }),
      msg({ id: "b", recipient_id: "ex2", session_id: "s2", sent_at: "2025-01-01T00:00:00Z" }),
    ];
    const { earlier } = partitionMessagesBySession(rows, PA, "s3");
    expect(earlier.map(g => g.counterpartId)).toEqual(["ex2", "ex1"]);
  });

  it("reads the counterpart from either participant column", () => {
    const { earlier } = partitionMessagesBySession(
      [msg({ id: "in", author_id: "ex", recipient_id: PA, session_id: "s1" })], PA, "s2",
    );
    expect(earlier[0].counterpartId).toBe("ex");
  });
});


// ── Standing schedules as countersigned agreements (1.6.0) ──────────────────

describe("compileCycle", () => {
  it("compiles every named pattern to a day-by-day party array", () => {
    expect(compileCycle("alternating_weeks")).toEqual(
      [..."aaaaaaa", ..."bbbbbbb"].map(c => c),
    );
    expect(compileCycle("two_two_three")).toHaveLength(14);
    expect(compileCycle("alternating_weekends")).toHaveLength(14);
  });

  it("passes a custom cycle through normalization", () => {
    expect(compileCycle("custom", "a,b,x")).toEqual([]);
    expect(compileCycle("custom", ["a", "b", "b"])).toEqual(["a", "b", "b"]);
  });

  it("returns nothing for a pattern it cannot compile", () => {
    // The caller treats [] as "cannot propose" — an agreement whose day-by-day
    // rule the hub could not read would be a promise the server cannot keep.
    expect(compileCycle("something_new")).toEqual([]);
    expect(compileCycle("custom", "")).toEqual([]);
  });
});

describe("custodyKeyForDate with a compiled cycle", () => {
  it("prefers the frozen cycle over the pattern name", () => {
    // Same array the hub materializer projects, so the in-app grid and the
    // server's custody days cannot disagree about a day.
    const version = {
      pattern: "alternating_weeks",
      cycle: JSON.stringify(["b", "b", "a"]),
      anchor_date: "2026-03-02",
      parent_a_id: "mom", parent_b_id: "dad", child_id: "kid",
    };
    expect(custodyKeyForDate(version, "2026-03-02")).toBe("b");
    expect(custodyKeyForDate(version, "2026-03-04")).toBe("a");
    // And still resolves correctly before the anchor.
    expect(custodyKeyForDate(version, "2026-03-01")).toBe("a");
  });
});

describe("mergeScheduleVersion", () => {
  const amendment = {
    id: "v2", child_id: "kid", pattern: "custom", cycle: '["a","b"]',
    anchor_date: "2026-03-02", proposed_by: "mom", created_at: "2026-02-01T00:00:00Z",
  };

  it("is a draft until the hub has an agreement row for it", () => {
    const merged = mergeScheduleVersion(amendment, undefined);
    expect(merged.status).toBe("draft");
    expect(merged.household_a_agreed).toBe(0);
  });

  it("takes every term from the frozen snapshot once one is bound", () => {
    // What the second parent reads must be exactly what they would sign, so a
    // post-proposal edit to the amendment row can never reach the display.
    const merged = mergeScheduleVersion(
      { ...amendment, anchor_date: "2099-01-01", pattern: "alternating_weeks" },
      {
        id: "v2", status: "pending", household_a_agreed: 1, household_b_agreed: 0,
        child_id: "kid", pattern: "custom", cycle: '["a","b"]', anchor_date: "2026-03-02",
        timezone: "America/Denver", base_version_id: "v1", proposed_by: "mom",
      },
    );
    expect(merged.anchor_date).toBe("2026-03-02");
    expect(merged.pattern).toBe("custom");
    expect(merged.base_version_id).toBe("v1");
    expect(merged.household_a_agreed).toBe(1);
  });

  it("survives the loss of its amendment row", () => {
    const merged = mergeScheduleVersion({ id: "v1" }, {
      id: "v1", status: "agreed", child_id: "kid", cycle: '["a"]',
      anchor_date: "2026-01-01", agreed_at: "2026-01-02T00:00:00Z",
      household_a_agreed: 1, household_b_agreed: 1,
    });
    expect(merged.status).toBe("agreed");
    expect(merged.agreed_at).toBe("2026-01-02T00:00:00Z");
  });
});

describe("version selection", () => {
  const versions = [
    { id: "v0", child_id: "kid", status: "superseded" },
    { id: "v1", child_id: "kid", status: "agreed" },
    { id: "v2", child_id: "kid", status: "pending", created_at: "2026-02-01T00:00:00Z" },
    { id: "v3", child_id: "other", status: "agreed" },
    { id: "v4", child_id: "kid", status: "declined" },
  ];

  it("finds the version in force, per child", () => {
    expect(agreedVersion(versions, "kid").id).toBe("v1");
    expect(agreedVersion(versions, "nobody")).toBeNull();
  });

  it("finds the open proposal and ignores resolved ones", () => {
    expect(openAmendment(versions, "kid").id).toBe("v2");
    expect(openAmendment(versions, "other")).toBeNull();
  });

  it("prefers the newest of two open proposals", () => {
    const two = [
      { id: "old", child_id: "kid", status: "pending", created_at: "2026-01-01T00:00:00Z" },
      { id: "new", child_id: "kid", status: "pending", created_at: "2026-03-01T00:00:00Z" },
    ];
    expect(openAmendment(two, "kid").id).toBe("new");
  });
});

describe("amendmentStance", () => {
  const proposal = (over = {}) => ({
    id: "v2", status: "pending", proposed_by: "mom",
    household_a_agreed: 1, household_b_agreed: 0, ...over,
  });

  it("tells the proposer they are waiting on the other parent", () => {
    expect(amendmentStance(proposal(), "mom")).toBe("awaiting_them");
    expect(canSignAmendment(proposal(), "mom")).toBe(false);
  });

  it("tells the other parent it is their signature that is missing", () => {
    expect(amendmentStance(proposal(), "dad")).toBe("awaiting_you");
    expect(canSignAmendment(proposal(), "dad")).toBe(true);
  });

  it("lets a proposer whose own bootstrap signature failed retry it", () => {
    // The propose and the signature are two calls; the second can fail on its
    // own, and the proposal would otherwise be unsignable by anyone.
    const stalled = proposal({ household_a_agreed: 0 });
    expect(amendmentStance(stalled, "mom")).toBe("awaiting_you");
    expect(canSignAmendment(stalled, "mom")).toBe(true);
  });

  it("refuses to sign anything already resolved", () => {
    expect(canSignAmendment(proposal({ status: "agreed" }), "dad")).toBe(false);
    expect(canSignAmendment(proposal({ status: "declined" }), "dad")).toBe(false);
    expect(canSignAmendment(null, "dad")).toBe(false);
  });

  it("takes the hub's word over its own guess about which side signed", () => {
    // A co-parent seat replaced while a proposal is open: the new steward did
    // not propose it, so the guess puts them on the wrong side and offers a
    // countersign button that changes nothing however often it is pressed.
    // `already_agreed` from /api/agree is the correction.
    expect(amendmentStance(proposal(), "newsteward")).toBe("awaiting_you");
    expect(amendmentStance(proposal(), "newsteward", true)).toBe("awaiting_them");
    expect(canSignAmendment(proposal(), "newsteward", true)).toBe(false);
  });

  it("never lets the correction hand out authority the guess withheld", () => {
    // The override only ever moves toward "signed". Nothing about the hub
    // reporting a prior signature should turn a read-only view into a signable
    // one, so `false` leaves the ordinary derivation exactly as it was.
    expect(canSignAmendment(proposal(), "dad", false)).toBe(true);
    expect(canSignAmendment(proposal({ status: "agreed" }), "dad", true)).toBe(false);
  });
});


describe("scheduleNoticeAudience", () => {
  const coParentA = { id: "a", role: "adult", isAdmin: true, hasLogin: true };
  const coParentB = { id: "b", role: "adult", isAdmin: true, hasLogin: true };
  const stepParent = { id: "step", role: "adult", isAdmin: false, hasLogin: true };
  const child = { id: "kid", role: "child", isAdmin: false, hasLogin: false };

  it("addresses the other co-parent, not the pairing", () => {
    // The bug this replaces: notifications went to the app's partner_config
    // row, so two co-parents who never completed the in-app pairing step could
    // have a schedule proposed, countersigned and superseded in silence.
    expect(scheduleNoticeAudience([coParentA, coParentB, child], "a")).toEqual(["b"]);
  });

  it("does not notify a child", () => {
    expect(scheduleNoticeAudience([coParentA, child], "a")).toEqual([]);
  });

  it("prefers the co-parents over a supporting adult", () => {
    // A step-parent may READ the schedule; they are not a party to changing it,
    // so they are not who a countersignature request is addressed to.
    expect(scheduleNoticeAudience([coParentA, coParentB, stepParent], "a")).toEqual(["b"]);
  });

  it("falls back to every other adult rather than going silent", () => {
    // Fails OPEN, deliberately and unlike an access decision: the recipient can
    // already read the schedule, so the only cost of over-delivery is a
    // notification, while under-delivery is the silence being fixed.
    expect(scheduleNoticeAudience([coParentA, stepParent], "a")).toEqual(["step"]);
  });

  it("returns nobody when the proposer is alone", () => {
    expect(scheduleNoticeAudience([coParentA], "a")).toEqual([]);
    expect(scheduleNoticeAudience([], "a")).toEqual([]);
    expect(scheduleNoticeAudience(null, "a")).toEqual([]);
  });
});
