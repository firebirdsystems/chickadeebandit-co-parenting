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

// Alternating weekends over a 14-day cycle: parent A has the children on
// school nights throughout, parent B takes every other Friday/Saturday/Sunday.
// Fri-Sun (3 nights) rather than Sat-Sun is the common decree default.
//
// Like TWO_TWO_THREE this is indexed off `anchor_date`, so the anchor carries
// the weekday alignment: day 0 must be the MONDAY of a week in which parent B
// has the weekend. The schedule form says so where the anchor is entered.
const ALTERNATING_WEEKENDS = [
  "a", "a", "a", "a", "b", "b", "b",   // Mon–Thu with A, Fri–Sun with B
  "a", "a", "a", "a", "a", "a", "a",   // the off week is entirely A's
];

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

    case "alternating_weekends":
      return ALTERNATING_WEEKENDS[mod(offset, 14)];

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
 * Override-shaped entries derived from LOCKED swaps — the only thing that can
 * move a day off the base rotation.
 *
 * The schedule effect of a swap comes from the agreement row's term snapshot
 * (frozen server-side at the moment of lock, in an endpoint_only table) —
 * never from the still-writable swap_requests row, and never from a
 * separately-written overrides row. That is what makes a locked swap binding
 * on the calendar: nothing either parent can write after the lock changes
 * what was agreed. Input may be the agreement rows directly; legacy or
 * incomplete rows without a full snapshot produce nothing rather than a wrong
 * day.
 *
 * `created_at: locked_at` feeds effectiveForDate's later-wins rule: of two
 * locked swaps covering the same day, the later countersign prevails.
 */
export function lockedSwapOverrides(swaps) {
  return (swaps || [])
    .filter((s) => s.status === "locked"
      && s.child_id && s.start_date && s.end_date && s.to_parent_id)
    .map((s) => ({
      id: s.id,
      child_id: s.child_id,
      start_date: s.start_date,
      end_date: s.end_date,
      parent_id: s.to_parent_id,
      created_at: s.locked_at ?? "",
    }));
}

/**
 * Combines the mutable request presentation row with its endpoint-owned
 * agreement state. Once the first consent binds a snapshot, every displayed
 * term comes strictly from that snapshot, including while still pending;
 * request fields are never a fallback. The request may be absent entirely
 * after lock without erasing the record.
 */
export function mergeSwapRecord(request = {}, agreement) {
  const locked = agreement?.status === "locked";
  const resolved = agreement?.status === "declined" || agreement?.status === "cancelled";
  const hasSnapshot = !!agreement
    && ["child_id", "start_date", "end_date", "to_parent_id"]
      .some((column) => agreement[column] != null);
  const bound = locked || (hasSnapshot
    && (resolved || agreement.requester_agreed || agreement.responder_agreed));
  const status = locked ? "locked"
    : resolved ? agreement.status
    : (request.status === "declined" || request.status === "cancelled") ? request.status : "pending";
  const terms = bound ? {
    child_id: agreement.child_id,
    start_date: agreement.start_date,
    end_date: agreement.end_date,
    to_parent_id: agreement.to_parent_id,
    note: agreement.note,
  } : {};
  return {
    ...request,
    requester_id: agreement?.requester_id ?? request.requester_id,
    responder_id: agreement?.responder_id ?? request.responder_id,
    created_at: request.created_at ?? agreement?.locked_at ?? agreement?.updated_at ?? null,
    ...terms,
    status,
    requester_agreed: agreement?.requester_agreed ? 1 : 0,
    responder_agreed: agreement?.responder_agreed ? 1 : 0,
    locked_at: agreement?.locked_at ?? null,
  };
}

/** A party whose durable flag is absent may retry consent. This primarily
 * recovers a request insert that committed before its bootstrap /api/agree call
 * failed, but it also keeps the action symmetric for either participant. */
export function canMemberAgreeToSwap(swap, memberId) {
  if (!swap || !memberId || swap.status !== "pending") return false;
  if (swap.requester_id === memberId) return !swap.requester_agreed;
  if (swap.responder_id === memberId) return !swap.responder_agreed;
  return false;
}

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

// ── Materialized custody days (agenda / glance source) ──────────────────────

/**
 * Format a stored 'HH:MM' exchange time for display ("17:00" → "5:00 PM").
 * Returns '' for anything unparseable so callers can fall back cleanly.
 */
export function fmtExchangeTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return "";
  const h = Number(m[1]);
  const min = m[2];
  if (h > 23 || Number(min) > 59) return "";
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${suffix}`;
}

/**
 * Materialize the rotation into one row per child per day, for the hub's
 * `agenda` (Today) and `glance` surfaces.
 *
 * Why materialize at all: `agenda`/`glance` are single governed SELECTs the hub
 * runs itself — they can't call this rotation engine. So the app writes the
 * resolved days into app_co_parenting__custody_days and the hub reads that.
 * The rows are pure derived state; rebuilding them from scratch is always safe.
 *
 *   schedules / overrides — same shapes as buildCalendarEvents
 *   opts.startDate / opts.endDate — 'YYYY-MM-DD' window (inclusive)
 *   opts.childName(id) / opts.parentName(id) — display names
 *
 * `is_transition` is 1 on a day whose custodial parent differs from the day
 * before it, which is what the glance surfaces as "next handoff". The day
 * *before* startDate is resolved too (and then dropped) so the first day in the
 * window isn't reported as a handoff just because the window began there.
 */
export function buildCustodyDays(schedules, overrides, opts) {
  const { startDate, endDate } = opts;
  const childName = opts.childName || ((id) => id);
  const parentName = opts.parentName || ((id) => id);
  const rows = [];

  for (const schedule of schedules || []) {
    if (schedule.status && schedule.status !== "active") continue;

    // Start one day early purely to seed `prev`; that row is not emitted.
    const assignments = assignmentsForRange(schedule, overrides, addDays(startDate, -1), endDate);
    let prev = null;
    for (const a of assignments) {
      const prevParent = prev?.parent_id ?? null;
      prev = a;
      if (a.date < startDate) continue;
      if (!a.parent_id) continue;            // unresolved day (bad config) — skip

      const isTransition = prevParent != null && prevParent !== a.parent_id;
      const parent = parentName(a.parent_id);
      const child = childName(schedule.child_id);
      const time = fmtExchangeTime(schedule.exchange_time);

      rows.push({
        id: `${schedule.child_id}:${a.date}`,
        child_id: schedule.child_id,
        day: a.date,
        parent_id: a.parent_id,
        from_parent_id: isTransition ? prevParent : null,
        is_transition: isTransition ? 1 : 0,
        exchange_time: schedule.exchange_time ?? null,
        source: a.source,
        title: isTransition ? `${child} → ${parent}` : `${child} with ${parent}`,
        subtitle: isTransition
          ? (time ? `Handoff ${time}` : "Handoff today")
          : `With ${parent}`,
      });
    }
  }
  return rows;
}

/**
 * The next handoff at or after `fromDate`, from materialized custody days.
 * → the row, or null when the window holds no upcoming transition.
 */
export function nextTransition(custodyDays, fromDate, childId) {
  let best = null;
  for (const row of custodyDays || []) {
    if (!row.is_transition) continue;
    if (childId && row.child_id !== childId) continue;
    if (toDayNumber(row.day) < toDayNumber(fromDate)) continue;
    if (!best || toDayNumber(row.day) < toDayNumber(best.day)) best = row;
  }
  return best;
}

// ── Handoff notes ↔ custody transitions ─────────────────────────────────────
//
// Notes are anchored by DATE (`note_date`), not by a foreign key to a
// custody_days row. That is deliberate:
//
//   - custody_days is derived state, rebuilt wholesale (DELETE + INSERT) every
//     time a schedule or override changes, and it disappears entirely when a
//     schedule is archived. An FK into it would dangle.
//   - handoff_notes is an append_only_records table: no edit, no delete. A note
//     anchored to the wrong row could never be repointed. The looser coupling
//     is what makes drift survivable — a note whose transition moved still
//     reads as "note for Aug 7" instead of pointing at nothing.
//
// So the association is derived here, at read time, and is allowed to be wrong
// without corrupting anything.

/**
 * The upcoming transitions a note can be written against, nearest first.
 * Drawn from the materialized rotation, so this only ever offers dates the
 * schedule actually produces — and it reaches into the future (custody_days is
 * materialized ~120 days out), which is what makes writing a note BEFORE the
 * handoff the normal path rather than a trick.
 */
export function upcomingTransitions(custodyDays, fromDate, { childId = null, limit = 8 } = {}) {
  return (custodyDays || [])
    .filter((r) => r.is_transition)
    .filter((r) => (childId ? r.child_id === childId : true))
    .filter((r) => toDayNumber(r.day) >= toDayNumber(fromDate))
    .sort((a, b) => toDayNumber(a.day) - toDayNumber(b.day))
    .slice(0, limit);
}

/**
 * Group notes under the transition they belong to.
 *
 * A note joins a transition when the child and date both match. Notes that
 * match no transition — the schedule moved, the schedule was archived, or the
 * note was simply written for an ordinary day — are NOT dropped; they come back
 * under `unanchored` so an append-only record can never become invisible just
 * because derived state changed underneath it.
 *
 * → { groups: [{ transition, notes, isUpcoming }], unanchored: [notes] }
 */
export function groupNotesByTransition(notes, custodyDays, todayStr) {
  const transitions = (custodyDays || []).filter((r) => r.is_transition);
  const key = (childId, day) => `${childId} ${day}`;
  const byKey = new Map(transitions.map((t) => [key(t.child_id, t.day), t]));

  const groups = new Map();
  const unanchored = [];

  for (const note of notes || []) {
    const transition = byKey.get(key(note.child_id, note.note_date));
    if (!transition) { unanchored.push(note); continue; }
    const k = key(note.child_id, note.note_date);
    let group = groups.get(k);
    if (!group) {
      group = {
        transition,
        notes: [],
        isUpcoming: toDayNumber(transition.day) >= toDayNumber(todayStr),
      };
      groups.set(k, group);
    }
    group.notes.push(note);
  }

  // Soonest upcoming handoff first, then past ones most-recent first — the note
  // you need is almost always for the exchange that hasn't happened yet.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.isUpcoming !== b.isUpcoming) return a.isUpcoming ? -1 : 1;
    const da = toDayNumber(a.transition.day);
    const db = toDayNumber(b.transition.day);
    return a.isUpcoming ? da - db : db - da;
  });

  unanchored.sort((a, b) => String(b.note_date).localeCompare(String(a.note_date)));
  return { groups: ordered, unanchored };
}

/** How many notes are already filed for a given child+date. */
export function notesForTransition(notes, childId, day) {
  return (notes || []).filter((n) => n.child_id === childId && n.note_date === day);
}

// ── Co-parent identification ────────────────────────────────────────────────

/**
 * The one other adult who can only be the co-parent, or null.
 *
 * Pairing exists because the message log is `couple_scoped`, and it also names
 * the counterparty for swap requests and notifications. Making the user hunt
 * for it in Setup is the friction; guessing it wrong would be far worse, so
 * this only answers when there is nothing to guess.
 *
 * `family.members` exposes id/name/role/isAdmin/hasLogin but NOT the home
 * household, so "the adult from the other house" is not a distinction this app
 * can draw. Unambiguity is: exactly one other adult who could reciprocate.
 * That is the two-parent case, i.e. the norm — and it deliberately returns null
 * once a third adult (a new spouse) is in the space, where picking wrong would
 * hand a private message log to the wrong person.
 *
 * Members with no login are excluded: pairing only takes effect when they name
 * you back, which an account-less row can never do.
 */
export function soleCoParentCandidate(adultMembers, meId) {
  if (!meId) return null;
  const candidates = (adultMembers || [])
    .filter((m) => m.id !== meId && m.hasLogin !== false);
  return candidates.length === 1 ? candidates[0] : null;
}

// ── Schedule change description ─────────────────────────────────────────────
//
// Schedules and overrides are `adult_writable`: either co-parent may change the
// rotation directly, without the other countersigning. That is the deliberate
// peer model (see migrations/001_init.sql) — but a change the other parent is
// never told about is indistinguishable from one made behind their back. So
// every write is announced, naming what moved. `audit_writes` already keeps the
// durable record; this is what points the other parent at it.

const SCHEDULE_FIELD_LABELS = [
  ["pattern", "the rotation pattern"],
  ["cycle", "the custom cycle"],
  ["anchor_date", "the cycle start date"],
  ["parent_a_id", "which parent is Parent A"],
  ["parent_b_id", "which parent is Parent B"],
  ["exchange_time", "the exchange time"],
];

/** Join a list the way a person would: "a", "a and b", "a, b and c". */
export function joinPhrases(parts) {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * A human phrase for what changed between two versions of a schedule row, or
 * null when nothing meaningful did — the caller uses null to skip the notify,
 * so re-saving an untouched form doesn't ping the other parent.
 *
 * `cycle_length` is deliberately not listed: it is derived from `cycle` and
 * would double-report every custom-cycle edit.
 */
export function describeScheduleChange(before, after) {
  if (!before) return null;
  const changed = SCHEDULE_FIELD_LABELS
    .filter(([field]) => (before[field] ?? null) !== (after[field] ?? null))
    .map(([, label]) => label);
  return changed.length ? joinPhrases(changed) : null;
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

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * The message log is permanent and grows for years — it is a record
 * both parents rely on, so finding an old message matters more here
 * than in an ordinary chat.
 */
export function searchableFields(message, authorName = "") {
  return [message.body, authorName];
}
