import { describe, it, expect } from "vitest";
import {
  CHECKIN_KIND, groupExchanges, transitionTimeZone, localDateTime, minutesFromAgreed, describeArrival,
  exchangeCheckins, collapseByExchange, exchangeOutcome,
} from "../src/logic.js";

const t = (child_id, day, extra = {}) => ({
  child_id, day, from_parent_id: "mom", parent_id: "dad", exchange_time: "17:00", is_transition: 1, ...extra,
});

describe("groupExchanges", () => {
  it("makes children who change homes together one exchange", () => {
    const groups = groupExchanges([t("emma", "2026-10-23"), t("leo", "2026-10-23")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ day: "2026-10-23", from_parent_id: "mom", parent_id: "dad", exchange_time: "17:00" });
    expect(groups[0].child_ids).toEqual(["emma", "leo"]);
  });

  it("keeps apart exchanges that differ in day, direction or time", () => {
    const groups = groupExchanges([
      t("emma", "2026-10-23"),
      t("leo", "2026-10-24"),
      t("sam", "2026-10-23", { from_parent_id: "dad", parent_id: "mom" }),
      t("ava", "2026-10-23", { exchange_time: "09:00" }),
    ]);
    expect(groups.map((g) => g.child_ids)).toEqual([["emma"], ["leo"], ["sam"], ["ava"]]);
  });

  it("keeps apart children whose schedules keep different clocks", () => {
    const zone = { emma: "America/Denver", leo: "America/New_York" };
    const groups = groupExchanges([t("emma", "2026-10-23"), t("leo", "2026-10-23")], (x) => zone[x.child_id]);
    expect(groups.map((g) => g.child_ids)).toEqual([["emma"], ["leo"]]);
    expect(groups.map((g) => g.zone)).toEqual(["America/Denver", "America/New_York"]);
  });

  it("counts a child once however often its transition arrives", () => {
    expect(groupExchanges([t("emma", "2026-10-23"), t("emma", "2026-10-23")])[0].child_ids).toEqual(["emma"]);
    expect(groupExchanges(undefined)).toEqual([]);
  });
});

describe("transitionTimeZone", () => {
  const versions = [
    { id: "v1", child_id: "emma", status: "superseded", timezone: "America/Denver" },
    { id: "v2", child_id: "emma", status: "agreed", timezone: "America/New_York" },
    { id: "v0", child_id: "emma", status: "superseded", timezone: null },
  ];

  it("keeps a day on the clock of the version that produced it, not the one now in force", () => {
    expect(transitionTimeZone(t("emma", "2026-10-01", { source_version_id: "v1" }), versions, "UTC")).toBe("America/Denver");
    expect(transitionTimeZone(t("emma", "2026-10-30", { source_version_id: "v2" }), versions, "UTC")).toBe("America/New_York");
  });

  it("takes the fallback for a version kept without a zone, and says nothing for a version it does not hold", () => {
    expect(transitionTimeZone(t("emma", "2026-09-01", { source_version_id: "v0" }), versions, "America/Chicago")).toBe("America/Chicago");
    expect(transitionTimeZone(t("emma", "2026-09-01", { source_version_id: "gone" }), versions, "UTC")).toBeUndefined();
    expect(transitionTimeZone(t("emma", "2026-09-01"), versions, "UTC")).toBeUndefined();
  });

  it("measures an on-time check-in at a Denver exchange as on time after a move to New York", () => {
    const day = t("emma", "2026-10-01", { source_version_id: "v1" });
    const zone = transitionTimeZone(day, versions, "UTC");
    // 17:00 in Denver (MDT, UTC−6) is 23:00 UTC; on New York's clock it would read 19:00.
    expect(minutesFromAgreed("2026-10-01T23:00:00Z", day.day, "17:00", zone)).toBe(0);
    expect(minutesFromAgreed("2026-10-01T23:00:00Z", day.day, "17:00", "America/New_York")).toBe(120);
  });

  it("keeps apart one child's days from before and after a zone change", () => {
    const zoneOf = (x) => transitionTimeZone(x, versions, "UTC");
    const groups = groupExchanges([
      t("emma", "2026-10-23", { source_version_id: "v1" }),
      t("leo", "2026-10-23", { source_version_id: "v2" }),
    ], zoneOf);
    expect(groups.map((g) => g.zone)).toEqual(["America/Denver", "America/New_York"]);
  });
});

describe("check-in times", () => {
  it("reads an instant on the schedule's own clock", () => {
    // 23:19 UTC is 17:19 in Denver (MDT, UTC−6) on the same date.
    expect(localDateTime("2026-10-23T23:19:00Z", "America/Denver")).toEqual({ date: "2026-10-23", hhmm: "17:19", minutes: 17 * 60 + 19 });
    // …and already the next day in UTC.
    expect(localDateTime("2026-10-24T01:30:00Z", "America/Denver").date).toBe("2026-10-23");
    expect(localDateTime("nonsense", "UTC")).toBeNull();
    expect(localDateTime("2026-10-23T12:00:00Z", "Not/AZone")).toBeNull();
  });

  it("measures a check-in against the agreed time, after and before", () => {
    expect(minutesFromAgreed("2026-10-23T23:19:00Z", "2026-10-23", "17:00", "America/Denver")).toBe(19);
    expect(minutesFromAgreed("2026-10-23T22:50:00Z", "2026-10-23", "17:00", "America/Denver")).toBe(-10);
  });

  it("says nothing when there is no agreed time or the check-in was another day", () => {
    expect(minutesFromAgreed("2026-10-23T23:19:00Z", "2026-10-23", null, "America/Denver")).toBeNull();
    // The next morning is a check-in on another day, not fifteen hours late.
    expect(minutesFromAgreed("2026-10-24T15:00:00Z", "2026-10-23", "17:00", "America/Denver")).toBeNull();
  });

  it("measures a late-evening exchange's check-in made just after midnight", () => {
    // Agreed 23:30 Denver; arrived 00:10 the next day (06:10 UTC).
    expect(minutesFromAgreed("2026-10-24T06:10:00Z", "2026-10-23", "23:30", "America/Denver")).toBe(40);
    // An early-evening exchange is not stretched into the night: 17:00 → 00:10 is past the limit.
    expect(minutesFromAgreed("2026-10-24T06:10:00Z", "2026-10-23", "17:00", "America/Denver")).toBeNull();
  });

  it("states the difference as a fact", () => {
    expect(describeArrival(0)).toBe("at the agreed time");
    expect(describeArrival(19)).toBe("19 min after the agreed time");
    expect(describeArrival(-10)).toBe("10 min before the agreed time");
    expect(describeArrival(65)).toBe("1 h 5 min after the agreed time");
    expect(describeArrival(120)).toBe("2 h after the agreed time");
    expect(describeArrival(null)).toBe("");
  });
});

describe("exchangeCheckins", () => {
  const exchange = { day: "2026-10-23", child_ids: ["emma", "leo"] };
  const row = (id, created_by, child_id, created_at, extra = {}) =>
    ({ id, kind: CHECKIN_KIND, day: "2026-10-23", created_by, child_id, created_at, ...extra });

  it("is one arrival per adult, at their earliest row, earliest adult first", () => {
    const log = [
      row("d1", "dad", "emma", "2026-10-23T23:19:00Z"),
      row("m1", "mom", "emma", "2026-10-23T23:02:00Z"),
      row("m2", "mom", "leo", "2026-10-23T23:02:01Z"),
      row("m3", "mom", "emma", "2026-10-23T23:40:00Z"),
    ];
    const got = exchangeCheckins(log, exchange);
    expect(got.map((c) => [c.created_by, c.created_at, c.child_ids])).toEqual([
      ["mom", "2026-10-23T23:02:00Z", ["emma", "leo"]],
      ["dad", "2026-10-23T23:19:00Z", ["emma"]],
    ]);
    expect(got[0].entries).toHaveLength(3);
  });

  it("keeps a later tap for a child who joined the exchange at its own time", () => {
    const log = [
      row("m1", "mom", "emma", "2026-10-23T23:02:00Z", { exchange_id: "x" }),
      row("m2", "mom", "leo", "2026-10-24T01:40:00Z", { exchange_id: "y" }),
    ];
    expect(exchangeCheckins(log, exchange).map((c) => [c.created_at, c.child_ids])).toEqual([
      ["2026-10-23T23:02:00Z", ["emma"]],
      ["2026-10-24T01:40:00Z", ["leo"]],
    ]);
  });

  it("ignores other days, other children and other kinds", () => {
    const log = [
      row("x", "mom", "emma", "2026-10-22T23:00:00Z", { day: "2026-10-22" }),
      row("y", "mom", "sam", "2026-10-23T23:00:00Z"),
      { id: "z", kind: "exchange_as_planned", day: "2026-10-23", child_id: "emma", created_by: "mom", created_at: "2026-10-23T23:00:00Z" },
    ];
    expect(exchangeCheckins(log, exchange)).toEqual([]);
  });

  it("is not an account of the exchange's outcome", () => {
    const log = [row("m1", "mom", "emma", "2026-10-23T23:02:00Z")];
    expect(exchangeOutcome(log, "emma", "2026-10-23").state).toBe("unrecorded");
  });
});

describe("collapseByExchange", () => {
  it("shows rows written together as one account, in order", () => {
    const rows = [
      { id: "a", child_id: "emma", exchange_id: "x" },
      { id: "b", child_id: "emma" },
      { id: "c", child_id: "leo", exchange_id: "x" },
      { id: "d", child_id: "leo" },
    ];
    expect(collapseByExchange(rows).map((g) => [g.entry.id, g.rows.map((r) => r.id), g.child_ids])).toEqual([
      ["a", ["a", "c"], ["emma", "leo"]],
      ["b", ["b"], ["emma"]],
      ["d", ["d"], ["leo"]],
    ]);
  });

  it("never folds one adult's rows into another's account", () => {
    const rows = [
      { id: "a", child_id: "emma", exchange_id: "x", created_by: "mom" },
      { id: "b", child_id: "leo", exchange_id: "x", created_by: "dad" },
    ];
    expect(collapseByExchange(rows).map((g) => g.rows.map((r) => r.id))).toEqual([["a"], ["b"]]);
  });
});
