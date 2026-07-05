// Pure, DOM-free custody rotation engine for the Co-Parenting app.
// Everything here is deterministic and unit-tested in __tests__/logic.test.mjs —
// no browser globals, no DB calls, no app state. Dates are handled as
// 'YYYY-MM-DD' strings in UTC so results never shift with the local timezone or DST.

// ── Date helpers ────────────────────────────────────────────────────────────

/** Parse 'YYYY-MM-DD' into a UTC-midnight epoch-day integer. */
export function toDayNumber(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Inverse of toDayNumber → 'YYYY-MM-DD'. */
export function fromDayNumber(dayNum) {
  const dt = new Date(dayNum * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole days from a → b (b - a). Negative if b precedes a. */
export function daysBetween(aStr, bStr) {
  return toDayNumber(bStr) - toDayNumber(aStr);
}

/** dateStr shifted by n days (n may be negative). */
export function addDays(dateStr, n) {
  return fromDayNumber(toDayNumber(dateStr) + n);
}

/** Always-positive modulo (JS % keeps the sign of the dividend). */
function mod(n, m) {
  return ((n % m) + m) % m;
}

// ── Rotation patterns ───────────────────────────────────────────────────────

// 2-2-3 over a 14-day cycle. Week 1: A A B B A A A, week 2: B B A A B B B.
// Each parent alternates the long (3-day) weekend, and neither is ever away
// more than 3 days in a row — the standard 2-2-3 arrangement.
const TWO_TWO_THREE = ["a", "a", "b", "b", "a", "a", "a", "b", "b", "a", "a", "b", "b", "b"];

/**
 * Which parent ('a' or 'b') has a child on a given date under the base rotation
 * (ignores overrides). Returns null if the date can't be resolved (bad config).
 */
export function custodyKeyForDate(schedule, dateStr) {
  if (!schedule || !schedule.anchor_date) return null;
  const offset = daysBetween(schedule.anchor_date, dateStr);

  switch (schedule.pattern) {
    case "alternating_weeks":
      return mod(offset, 14) < 7 ? "a" : "b";

    case "two_two_three":
      return TWO_TWO_THREE[mod(offset, 14)];

    case "custom": {
      const cycle = normalizeCycle(schedule.cycle);
      if (!cycle.length) return null;
      return cycle[mod(offset, cycle.length)];
    }

    default:
      return null;
  }
}

/** Resolve a custody key ('a'/'b') to the actual parent member id. */
export function keyToParentId(schedule, key) {
  if (key === "a") return schedule.parent_a_id;
  if (key === "b") return schedule.parent_b_id;
  return null;
}

/** custodyKeyForDate + keyToParentId in one call. */
export function baseParentForDate(schedule, dateStr) {
  return keyToParentId(schedule, custodyKeyForDate(schedule, dateStr));
}

/** Accepts a JSON string or an array; returns a clean array of 'a'/'b'. */
export function normalizeCycle(cycle) {
  let arr = cycle;
  if (typeof cycle === "string") {
    try { arr = JSON.parse(cycle); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((c) => c === "a" || c === "b");
}

// ── Overrides ───────────────────────────────────────────────────────────────

/**
 * Effective parent id for a child on a date, applying overrides on top of the
 * base rotation. Later-created overrides win when ranges overlap. `overrides`
 * may include entries for other children; they're filtered by schedule.child_id.
 * Returns { parent_id, source: 'schedule' | 'override', override_id? }.
 */
export function effectiveForDate(schedule, overrides, dateStr) {
  const day = toDayNumber(dateStr);
  let winner = null;
  for (const ov of overrides || []) {
    if (ov.child_id !== schedule.child_id) continue;
    if (day < toDayNumber(ov.start_date) || day > toDayNumber(ov.end_date)) continue;
    if (!winner || String(ov.created_at) > String(winner.created_at)) winner = ov;
  }
  if (winner) return { parent_id: winner.parent_id, source: "override", override_id: winner.id };
  return { parent_id: baseParentForDate(schedule, dateStr), source: "schedule" };
}

/**
 * Day-by-day assignments for [startDate, endDate] inclusive.
 * → [{ date, parent_id, source, override_id? }]
 */
export function assignmentsForRange(schedule, overrides, startDate, endDate) {
  const out = [];
  const start = toDayNumber(startDate);
  const end = toDayNumber(endDate);
  for (let day = start; day <= end; day++) {
    const date = fromDayNumber(day);
    out.push({ date, ...effectiveForDate(schedule, overrides, date) });
  }
  return out;
}

/**
 * Collapse day-by-day assignments into contiguous same-parent blocks.
 * → [{ start, end, parent_id }] where end is the last day of the block (inclusive).
 */
export function mergeBlocks(assignments) {
  const blocks = [];
  for (const a of assignments) {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.parent_id === a.parent_id && daysBetween(prev.end, a.date) === 1) {
      prev.end = a.date;
    } else {
      blocks.push({ start: a.date, end: a.date, parent_id: a.parent_id });
    }
  }
  return blocks;
}

/**
 * Build hub calendar_events for one or more children over a date window.
 *
 *   schedules  — array of schedule rows (one per child)
 *   overrides  — flat array of override rows (any children)
 *   opts.startDate / opts.endDate — 'YYYY-MM-DD' window
 *   opts.childName(childId)   → display name for the child
 *   opts.parentName(parentId) → display name for the custodial parent
 *
 * Each event is an all-day block: "{Child} with {Parent}". `end` is exclusive
 * (day after the last custody day) to match how all-day calendar ranges render.
 */
export function buildCalendarEvents(schedules, overrides, opts) {
  const { startDate, endDate } = opts;
  const childName = opts.childName || ((id) => id);
  const parentName = opts.parentName || ((id) => id);
  const events = [];

  for (const schedule of schedules || []) {
    if (schedule.status && schedule.status !== "active") continue;
    const assignments = assignmentsForRange(schedule, overrides, startDate, endDate)
      .filter((a) => a.parent_id); // drop unresolved days
    for (const block of mergeBlocks(assignments)) {
      events.push({
        id: `${schedule.child_id}:${block.start}`,
        title: `${childName(schedule.child_id)} with ${parentName(block.parent_id)}`,
        start: block.start,
        end: addDays(block.end, 1), // exclusive end
        all_day: true,
        source_label: "Co-Parenting",
      });
    }
  }
  return events;
}

// ── Swap-request validation ─────────────────────────────────────────────────

/**
 * Validate a proposed swap before writing it. Returns { ok: true } or
 * { ok: false, error }. Pure — the caller supplies today's date so this stays
 * deterministic and testable.
 */
export function validateSwap(swap, todayStr) {
  if (!swap.child_id) return { ok: false, error: "Pick a child." };
  if (!swap.start_date || !swap.end_date) return { ok: false, error: "Pick a date range." };
  if (toDayNumber(swap.end_date) < toDayNumber(swap.start_date)) {
    return { ok: false, error: "End date can't be before the start date." };
  }
  if (todayStr && toDayNumber(swap.start_date) < toDayNumber(todayStr)) {
    return { ok: false, error: "Swaps can only be proposed for future dates." };
  }
  if (!swap.to_parent_id) return { ok: false, error: "Choose who should have the child." };
  if (swap.requester_id && swap.requester_id === swap.responder_id) {
    return { ok: false, error: "The other parent must be a different person." };
  }
  return { ok: true };
}
