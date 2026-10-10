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

  // An agreed version carries the CANONICAL compiled cycle, whatever pattern it
  // was chosen from, and that cycle is what the hub materializer projects. So
  // when one is present it wins outright: the in-app month grid and the server's
  // custody days are then the same arithmetic over the same array, and cannot
  // drift because a named pattern's shape changed between releases.
  const compiled = normalizeCycle(schedule.cycle);
  if (compiled.length) return compiled[mod(offset, compiled.length)];

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

/**
 * Compile a chosen pattern into the CANONICAL agreed form: an array of 'a'/'b'
 * party tags, one per day, repeating from the anchor.
 *
 * This is the piece that lets the hub materialize custody days without knowing
 * anything about this app. The hub cannot run app JavaScript, so a schedule that
 * said only `pattern: "two_two_three"` would be a promise the server could not
 * read. Compiling at PROPOSE time means what the two parents countersign is the
 * literal day-by-day rule — which also settles a subtler problem: a later
 * release that "fixed" the shape of a named pattern would otherwise silently
 * redefine an agreement that was already signed.
 *
 * Returns [] for an unusable pattern, which callers treat as "cannot propose".
 */
export function compileCycle(pattern, customCycle) {
  switch (pattern) {
    case "alternating_weeks":
      return [...Array(7).fill("a"), ...Array(7).fill("b")];
    case "two_two_three":
      return [...TWO_TWO_THREE];
    case "alternating_weekends":
      return [...ALTERNATING_WEEKENDS];
    case "custom":
      return normalizeCycle(customCycle);
    default:
      return [];
  }
}

// ── Named shapes, for the custom cycle ──────────────────────────────────────

/**
 * Fortnight shapes people ask for by name that are NOT in the `pattern` enum.
 *
 * These are deliberately presets over the existing `custom` pattern rather than
 * new enum values, and the reason is worth keeping: since compileCycle, what a
 * schedule stores and what the hub projects is the canonical day-by-day array,
 * and `pattern` is the label beside it. A preset that writes the array
 * therefore produces a row byte-identical to one a new enum value would have
 * produced — so the enum would buy nothing but a stored name, at the price of
 * a manifest change and a second source of truth for the same fortnight.
 *
 * It also buys something the enum could not. A schedule already countersigned
 * as `custom` is frozen — it cannot be relabelled, because relabelling a signed
 * version is exactly what this app exists not to do. A name DERIVED from the
 * cycle (see nameForCycle) reads those old agreements correctly without
 * touching them, because it reads the thing that was actually signed.
 *
 * What a preset really removes is the transcription error: 2-2-5-5 typed by
 * hand as fourteen comma-separated letters is one wrong position away from a
 * different schedule, and nothing downstream can tell that it was a typo — both
 * parents countersign it and the calendar is quietly wrong for a year.
 *
 * `hint` is the anchor advice, and on these it matters more than the array
 * does: 2-2-5-5's whole point is that each parent keeps the same weekdays, and
 * that only holds if day 1 is the weekday the parents meant. A misaligned
 * anchor produces a valid-looking rotation that silently is not the pattern
 * they asked for.
 */
export const CYCLE_PRESETS = [
  {
    key: "two_two_five_five",
    label: "2-2-5-5",
    name: "2-2-5-5 rotation",
    // Also written 5-5-2-2 or 5-2-2-5 — the same fortnight entered at a
    // different point, which is why the name is matched on SHAPE below rather
    // than on where the array happens to start.
    cycle: ["a", "a", "b", "b", "a", "a", "a", "a", "a", "b", "b", "b", "b", "b"],
    hint: "Pick the Monday that opens Parent A's two-day block — on this pattern each parent keeps the same weekdays every week, and only the anchor makes that true.",
  },
  {
    key: "three_four_four_three",
    label: "3-4-4-3",
    name: "3-4-4-3 rotation",
    cycle: ["a", "a", "a", "b", "b", "b", "b", "a", "a", "a", "a", "b", "b", "b"],
    hint: "Pick the first day of Parent A's three-day block.",
  },
  {
    key: "four_three",
    label: "4-3",
    name: "4-3 rotation",
    // Seven days, not fourteen: the only pattern here that repeats weekly, so
    // the same parent has every weekend. Shape matching reduces a cycle to its
    // repeating period, so someone who wrote it out as a fortnight is told the
    // same name.
    cycle: ["a", "a", "a", "a", "b", "b", "b"],
    hint: "Pick the first day of Parent A's four-day block.",
  },
  {
    key: "every_other_weekend",
    weekdaySpecific: true,
    // Named by its NIGHTS, and so is the enum's three-night one in the picker
    // beside it. "Every other weekend" and "alternating weekends" are the same
    // phrase in the wild, used for both shapes, and the difference between them
    // is half again as many overnights on a schedule two people are about to
    // sign — so neither name is allowed to appear here without its nights.
    label: "Every other weekend (Fri–Sat, 2 nights)",
    // A BASE name. The weekdays are not part of it — see nameForCycle, which
    // works them out from the anchor rather than asserting them here.
    name: "Every other weekend",
    cycle: ["a", "a", "a", "a", "b", "b", "a", "a", "a", "a", "a", "a", "a", "a"],
    hint: "Pick the Monday that opens a week in which Parent B has the weekend.",
  },
  {
    key: "every_other_weekend_midweek",
    weekdaySpecific: true,
    label: "Every other weekend, plus a midweek night",
    name: "Every other weekend plus a midweek night",
    cycle: ["a", "a", "b", "a", "b", "b", "a", "a", "a", "b", "a", "a", "a", "a"],
    hint: "Pick the Monday that opens a week in which Parent B has the weekend; the midweek night is the Wednesday of each week.",
  },
];
/**
 * Every fortnight shape this app can name, as `[label, cycle]`.
 *
 * Built from compileCycle for the enum patterns rather than from a second copy
 * of their arrays: one table of shapes, so a name can never describe an array
 * the engine does not actually run.
 */
const NAMED_SHAPES = [
  { name: "Alternating weeks", cycle: compileCycle("alternating_weeks") },
  { name: "2-2-3 rotation", cycle: compileCycle("two_two_three") },
  // Its nights, for the reason spelled out on the every_other_weekend preset:
  // this name and that one are the same phrase to a reader, and they are not
  // the same schedule.
  { name: "Alternating weekends", cycle: compileCycle("alternating_weekends"), weekdaySpecific: true },
  ...CYCLE_PRESETS.map((preset) => ({ name: preset.name, cycle: preset.cycle, weekdaySpecific: preset.weekdaySpecific === true })),
];

/** Weekday order for display: the week starts on Monday, so Sat and Sun are
 *  adjacent at the end rather than split across the ends of the list. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 0 = Sunday. Day 0 (1970-01-01) was a Thursday, hence the +4. */
export function weekdayOf(dateStr) {
  return ((toDayNumber(dateStr) + 4) % 7 + 7) % 7;
}

/**
 * A cycle reduced to its SHAPE: the smallest of every rotation of it and of
 * its parent-swapped twin.
 *
 * Both invariances are properties of what a pattern name means, not
 * conveniences. "2-2-5-5" names the shape of the fortnight; where you start
 * counting is the anchor's job, and which parent is 'a' is the roster's — the
 * name says neither. So a parent who typed the same fortnight from their own
 * starting day, or with the parents the other way round, entered 2-2-5-5 and
 * should be told so.
 *
 * Used only for LABELLING. Nothing here feeds custody resolution, which always
 * runs the stored array exactly as it was signed.
 */
function cycleShape(cycle) {
  const days = reduceToPeriod(normalizeCycle(cycle));
  if (!days.length) return "";
  const swapped = days.map((day) => (day === "a" ? "b" : "a"));
  let smallest = null;
  for (const variant of [days, swapped]) {
    for (let start = 0; start < variant.length; start += 1) {
      const rotated = variant.slice(start).concat(variant.slice(0, start)).join("");
      if (smallest === null || rotated < smallest) smallest = rotated;
    }
  }
  return smallest;
}

/**
 * A cycle cut down to its shortest repeating block.
 *
 * 4-3 is a seven-night pattern, and a parent writing it into a field that says
 * "the sequence repeats" will quite reasonably write the fortnight out twice.
 * That is the same schedule — the engine's modulo produces identical days from
 * either — so it should carry the same name. Without this, one of the two
 * spellings is named and the other reads as an unnamed custom cycle, which
 * looks like the app disagreeing with itself about what the parent entered.
 */
function reduceToPeriod(days) {
  for (let period = 1; period < days.length; period += 1) {
    if (days.length % period !== 0) continue;
    if (days.every((day, i) => day === days[i % period])) return days.slice(0, period);
  }
  return days;
}

/**
 * A cycle's shape with its ORIENTATION kept: parent-swapped, but not rotated.
 *
 * Rotation invariance is right for a name that says nothing about weekdays —
 * 2-2-5-5 is 2-2-5-5 wherever you start counting. It is WRONG for a name that
 * does. "Every other weekend (Fri–Sat)" is a claim about which nights, and
 * which nights a position lands on depends on where day 1 is; rotate the array
 * and the same shape is a Saturday–Sunday arrangement wearing a Friday name.
 *
 * Parent swap stays invariant in both: no name here says which parent.
 */
function orientedShape(cycle) {
  const days = reduceToPeriod(normalizeCycle(cycle));
  if (!days.length) return "";
  const swapped = days.map((day) => (day === "a" ? "b" : "a")).join("");
  const plain = days.join("");
  return plain < swapped ? plain : swapped;
}

/**
 * The name for a cycle's shape, or null when it matches nothing known.
 *
 * Null is the common and correct answer: a hand-entered rotation that is not
 * one of the named shapes has no name, and inventing one for it would be a
 * label that claims more than the array says. Callers fall back to
 * "Custom N-day cycle".
 */
export function nameForCycle(cycle, anchorDate) {
  const shape = cycleShape(cycle);
  if (!shape) return null;
  const hit = NAMED_SHAPES.find((known) => cycleShape(known.cycle) === shape);
  if (!hit) return null;
  if (!hit.weekdaySpecific) return hit.name;

  // A weekday-specific shape places its nights by POSITION, and a position is
  // only a weekday once the anchor is fixed. So the weekdays are WORKED OUT
  // from the anchor rather than asserted by the name: the same array anchored
  // to a Tuesday is a Saturday-Sunday arrangement, and it is entitled to say
  // so. This is also why nothing here validates the anchor — there is no wrong
  // anchor, only a name that has to keep up with the one that was chosen.
  const weekdays = visitingWeekdays(cycle, anchorDate);
  // No anchor to reckon from (a half-finished draft), or a rotation whose
  // nights do not land on a weekend at all: say nothing rather than call
  // Monday and Tuesday a weekend. The caller falls back to "Custom N-day".
  if (!weekdays || !weekdays.some((d) => d === 0 || d === 6)) return null;
  return `${hit.name} (${formatWeekdaySpan(weekdays)})`;
}

/**
 * The weekdays the VISITING parent has, for a cycle anchored to a date.
 *
 * "Visiting" is whichever side holds fewer nights — the side these patterns
 * are named for. Null when there is no usable anchor or the sides are even, in
 * which case there is nothing for a weekend name to describe.
 */
export function visitingWeekdays(cycle, anchorDate) {
  const days = reduceToPeriod(normalizeCycle(cycle));
  if (!days.length || !anchorDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate))) return null;
  const aCount = days.filter((d) => d === "a").length;
  if (aCount * 2 === days.length) return null;
  const visiting = aCount * 2 < days.length ? "a" : "b";
  const anchor = weekdayOf(anchorDate);
  const seen = new Set();
  days.forEach((side, i) => { if (side === visiting) seen.add((anchor + i) % 7); });
  return WEEK_ORDER.filter((d) => seen.has(d));
}

/**
 * Weekdays as a compact span: [5,6] is "Fri–Sat", [3,5,6] is "Wed, Fri–Sat".
 *
 * Runs are collapsed in WEEK_ORDER, which starts on Monday — so Saturday and
 * Sunday are adjacent and a weekend reads as one range instead of two ends.
 */
export function formatWeekdaySpan(weekdays) {
  const ordered = WEEK_ORDER.filter((d) => weekdays.includes(d));
  const runs = [];
  for (const day of ordered) {
    const last = runs[runs.length - 1];
    const prev = last && WEEK_ORDER[WEEK_ORDER.indexOf(last[last.length - 1]) + 1];
    if (last && prev === day) last.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) => (run.length > 1 ? `${WEEKDAY_ABBR[run[0]]}\u2013${WEEKDAY_ABBR[run[run.length - 1]]}` : WEEKDAY_ABBR[run[0]]))
    .join(", ");
}

/**
 * The preset a cycle is an instance of, or null.
 *
 * ORIENTATION-PRESERVING, unlike nameForCycle: this drives the picker's
 * selection and the anchor advice, and both are about where day 1 sits. A
 * cycle rotated by a day is the same pattern and a different starting point,
 * so it is deliberately NOT recognised here — every preset's hint names the
 * block day 1 opens, and handing that advice to an array whose day 1 is
 * somewhere else is worse than the generic line. Reopening a draft saved from
 * a preset still selects it, because that array was written from the preset.
 *
 * Only the presets, never the enum patterns: the picker exists only inside the
 * custom branch.
 */
export function presetForCycle(cycle) {
  const days = reduceToPeriod(normalizeCycle(cycle)).join("");
  if (!days) return null;
  // EXACT: same rotation and same parents. Every preset hint names a block by
  // the parent who opens it ("Parent A's two-day block"), so a swapped array —
  // where day 1 opens Parent B's — must not be handed that sentence. Rotation
  // matters for the same reason: the hint is about where day 1 sits.
  return CYCLE_PRESETS.find((preset) => preset.cycle.join("") === days) ?? null;
}

/** The anchor advice for a custom cycle: the preset's, or the generic one. */
export function cycleAnchorHint(cycle) {
  return presetForCycle(cycle)?.hint ?? "The first day of the cycle; the sequence repeats from here.";
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

/**
 * Read a hand-typed custom cycle ("a,a,b,b") strictly.
 *
 * normalizeCycle is right for STORED cycles — it is lenient about what a row
 * holds — and wrong for typing: it drops anything that is not 'a' or 'b', so
 * "a,a,v,b" quietly became a three-day rotation instead of an error. A cycle one
 * day short is a different schedule that drifts a day every time it repeats,
 * and nothing downstream can tell it was a typo.
 *
 * Commas and whitespace both separate, case is ignored, and empty entries (a
 * trailing comma, a doubled one) are skipped.
 * → { cycle: ['a','b',…], error: null } or { cycle: [], error: "…" }
 */
export function parseCycleInput(text) {
  const tokens = String(text ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return { cycle: [], error: "Enter a custom cycle like a,a,b,b." };
  const at = tokens.findIndex((t) => t !== "a" && t !== "b");
  if (at !== -1) {
    return {
      cycle: [],
      error: `Day ${at + 1} of the cycle is "${tokens[at]}" — each day must be a or b, separated by commas.`,
    };
  }
  return { cycle: tokens, error: null };
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
 * Whether a date falls inside a version's `effective_from`..`effective_to`
 * window (both inclusive, either may be absent).
 *
 * The hub's projector clamps to this window BEFORE it looks at the cycle or at
 * any swap, so a day outside it has no custody row at all — not a rotation day,
 * not an excepted one. Anything here that resolved such a day anyway would be
 * the app drawing a schedule the server does not publish.
 */
export function withinEffectiveWindow(schedule, dateStr) {
  if (!schedule) return false;
  if (schedule.effective_from && String(dateStr) < String(schedule.effective_from)) return false;
  if (schedule.effective_to && String(dateStr) > String(schedule.effective_to)) return false;
  return true;
}

/**
 * True once a version's end date is behind `todayStr`.
 *
 * A retired schedule stays `agreed` — retirement is an amendment that adds an
 * end date, never a status — so "is there an agreed version" and "is there a
 * schedule running" are different questions, and only this answers the second.
 */
export function scheduleHasEnded(schedule, todayStr) {
  return !!schedule?.effective_to && !!todayStr && String(schedule.effective_to) < String(todayStr);
}

/**
 * How far ahead a swap can be countersigned, in days from today.
 *
 * Not a preference: it is `cycle_projection.horizon_days` in manifest.json. The
 * hub refuses to lock a swap that moves no projected day, and it only projects
 * this far, so a swap starting beyond it can be requested and can never be
 * agreed. The app cannot read its own manifest at runtime, so the number lives
 * here once and the manifest test pins the two equal.
 */
export const SWAP_HORIZON_DAYS = 120;

/**
 * A swap both parents have signed that is nevertheless still pending.
 *
 * It should not exist, and it does: the hub records a signature BEFORE it works
 * out whether the lock can be applied, so a countersignature it then refuses —
 * the dates lie beyond the projection horizon, or have already passed — leaves
 * both flags set on a row that never locked. Nothing retries it, and with both
 * flags set neither parent is offered "Agree" again, so without naming this
 * state the request simply sits there with no way forward and no way out.
 */
export function swapIsStalled(swap) {
  return !!swap && swap.status === "pending" && !!swap.requester_agreed && !!swap.responder_agreed;
}

/**
 * Why a stalled swap did not take effect, as seen from `todayStr`:
 *
 *   "past"    — its last day is behind us; it can only be withdrawn
 *   "too_far" — it starts beyond the horizon; it can be confirmed once it is
 *               within `horizonDays`, or withdrawn
 *   "retry"   — the dates are projectable now, so confirming again should lock
 *
 * @returns {"past"|"too_far"|"retry"|null} null when the swap is not stalled
 */
export function swapStallReason(swap, todayStr, horizonDays = SWAP_HORIZON_DAYS) {
  if (!swapIsStalled(swap)) return null;
  if (!swap.start_date || !swap.end_date) return "retry";
  if (toDayNumber(swap.end_date) < toDayNumber(todayStr)) return "past";
  if (toDayNumber(swap.start_date) > toDayNumber(todayStr) + horizonDays) return "too_far";
  return "retry";
}

/**
 * What is wrong with a swap's PARTIES, as a sentence, or null when they are the
 * child's two parents.
 *
 * A swap is an exception to an agreement between two specific people — the
 * `parent_a_id` and `parent_b_id` of the child's agreed version — so those are
 * the only two who can make one. This is the app's check, and it is NOT the
 * enforcement: `swap_requests` is `party_scoped` and the agreement runs in
 * `members` mode, so the hub will lock a swap between the requester and
 * whichever member the request names. Until the hub can pin an exception's
 * parties to the version it excepts, this keeps the app from ever CREATING or
 * COUNTERSIGNING such a swap, and makes one created some other way say so on
 * its face rather than read as an ordinary confirmed swap.
 */
export function swapPartyIssue(swap, schedule) {
  if (!swap) return "There is no swap to check.";
  if (!schedule) return "This child has no agreed schedule, so there is nothing for a swap to change.";
  const parents = [schedule.parent_a_id, schedule.parent_b_id];
  if (!parents.includes(swap.requester_id) || !parents.includes(swap.responder_id)
    || swap.requester_id === swap.responder_id) {
    return "A swap has to be agreed between the child's two parents on the schedule.";
  }
  if (swap.to_parent_id && !parents.includes(swap.to_parent_id)) {
    return "A swap can only move a day to one of the child's two parents on the schedule.";
  }
  return null;
}

/**
 * Effective parent id for a child on a date, applying overrides on top of the
 * base rotation. Later-created overrides win when ranges overlap. `overrides`
 * may include entries for other children; they're filtered by schedule.child_id.
 * A date outside the version's effective window resolves to nobody.
 * Returns { parent_id, source: 'schedule' | 'override', override_id? }.
 */
export function effectiveForDate(schedule, overrides, dateStr) {
  if (!withinEffectiveWindow(schedule, dateStr)) return { parent_id: null, source: "schedule" };
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
 * What one cell of the month grid should show.
 *
 * Two sources, split at today, and the split is the point:
 *
 *   - a day BEHIND today comes from `custody_days` — the record of what was
 *     actually published for that day. Recomputing it from the version in force
 *     now would repaint every past month the moment an amendment changed the
 *     cycle or the anchor, and contradict the custody report built from the
 *     same rows. A past day with no row is drawn empty, because that is what
 *     the record says.
 *   - today and the future come from the agreed version (inside its effective
 *     window) plus locked swaps — the same arithmetic the hub projects, which is
 *     what lets the grid reach past the projection horizon.
 *
 * `recordByDay` is a Map of day → custody_days row for this child.
 * → { parent_id, source: 'schedule' | 'override' | 'record' }
 */
export function calendarCell(schedule, overrides, recordByDay, dateStr, todayStr) {
  if (todayStr && String(dateStr) < String(todayStr)) {
    const row = recordByDay?.get(dateStr);
    if (!row) return { parent_id: null, source: "record" };
    return { parent_id: row.parent_id ?? null, source: row.source === "override" || row.source === "exception" ? "override" : "record" };
  }
  return effectiveForDate(schedule, overrides, dateStr);
}

/** First and last day of a calendar month ('YYYY-MM-DD'); `month` is 0-based. */
export function monthBounds(year, month) {
  const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const next = month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, "0")}-01`;
  return { first, last: addDays(next, -1) };
}

/**
 * How far behind today the first-render read of `custody_days` reaches.
 *
 * The table keeps every published day for as long as retention allows, so an
 * unbounded read grows by a row per child per day for ever. Six weeks back
 * covers the month on screen at launch and the recent handoffs notes hang off;
 * anything older is fetched when the grid is actually turned to it.
 * manifest.preload carries the same number in its SQL text — the manifest test
 * pins the two together.
 */
export const CUSTODY_LOOKBACK_DAYS = 45;

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
 * NO LONGER WRITTEN BY THIS APP as of 1.6.0 — the hub's `cycle_projection`
 * materializer owns both the `calendar_events` store key and the `custody_days`
 * table, and the manifest no longer carries a store write grant for the key.
 * Kept because it is the same arithmetic the in-app month grid renders from, and
 * because deleting it would leave the app unable to preview a schedule it has
 * not yet proposed.
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
 * Materialize the rotation into one row per child per day.
 *
 * NOT the source of `custody_days` any more. As of 1.6.0 that table is
 * `endpoint_only` and the hub's `cycle_projection` materializer is its only
 * writer, in the same transaction that locks the agreement — because a
 * projection the app could write was a projection either parent could rewrite
 * without touching what was agreed, and a browser that closed mid-write left
 * Today, the glance tile and the calendar disagreeing.
 *
 * What it is now: the PREVIEW engine. It renders the days a proposal would
 * produce, before anyone has countersigned it and therefore before the hub has
 * anything to project.
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

/**
 * A custody day for display, relative to `todayStr`.
 *
 *   within the coming week   "Fri"
 *   any other day this year  "Fri, Aug 8"
 *   another year             "Fri, Aug 8, 2025"
 *
 * Only an UPCOMING day may lose its date. The bare weekday is a shorthand for
 * "this coming Friday", and the old test for it (`day - today < 7 days`) was
 * true of every day in the past as well, so a handoff from months ago read as
 * just "Fri" on a record whose whole purpose is to say when.
 *
 * Formatted in UTC from the date string itself, so the label can never slip a
 * day in a timezone behind Greenwich.
 */
export function fmtHandoffDay(day, todayStr, locale = undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return String(day ?? "");
  const date = new Date(toDayNumber(day) * 86400000);
  const ahead = todayStr ? daysBetween(todayStr, day) : null;
  if (ahead !== null && ahead >= 0 && ahead < 7) {
    return date.toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
  }
  const sameYear = todayStr ? String(day).slice(0, 4) === String(todayStr).slice(0, 4) : false;
  return date.toLocaleDateString(locale, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The timezones the schedule form offers, and the one it starts on.
 *
 * The zone is an agreed term — it decides whose midnight ends a custody day —
 * so the choice has to be a real one. A tenant that has never set a timezone
 * reports "UTC", and when the form offered only the tenant's zone and UTC that
 * meant a single option: every schedule in such a space was frozen to UTC with
 * nobody having chosen it, and the hub's "today" for that schedule then rolled
 * over in the middle of the afternoon.
 *
 * So the proposer's own device zone is offered as well, and is the default
 * when the tenant has nothing better than UTC to suggest. It is only ever a
 * suggestion: the other parent reads the zone on the proposal and countersigns
 * it, or does not.
 *
 * `current` is the zone already on the version or draft being edited, which
 * always wins the default.
 * → { zones: string[], selected: string }
 */
export function timeZoneChoices({ current = null, space = null, device = null } = {}) {
  const zones = [...new Set([current, space, device, "UTC"].filter(Boolean))];
  const selected = current || (space && space !== "UTC" ? space : device || space || "UTC");
  return { zones, selected };
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
  const key = (childId, day) => `${childId}\u0000${day}`;
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

// ── Standing schedule versions and amendments ───────────────────────────────
//
// The standing rotation is an AGREEMENT, not a preference. Nothing here writes
// it: an amendment is proposed through the hub (which resolves the two
// participating households itself), and it becomes the schedule only once both
// parents countersign, at which point the hub freezes the terms and supersedes
// the version it amends.
//
// The app's job is to say clearly which of the five states each version is in,
// and never to present a proposal as though it were the schedule.

/**
 * Merge the mutable amendment row with its hub-owned agreement state.
 *
 * Mirrors `mergeSwapRecord`, and for the same reason: once the first signature
 * binds a snapshot, every displayed term comes from that snapshot and never
 * from the amendment row, so what the second parent reads is exactly what they
 * would be signing. Before that — and for a proposal nobody has signed yet —
 * the amendment row is the only source there is.
 */
export function mergeScheduleVersion(amendment = {}, agreement) {
  const status = agreement?.status ?? "draft";
  // Bound means the hub has frozen terms onto the agreement row, and the test
  // for that has to be a column ONLY the freeze writes. `child_id` is not one:
  // the hub copies it (with the two households and the base version) the moment
  // the row is created, before anyone has signed. A row in that state — created
  // by a signature the hub then refused — has a child and no terms, and reading
  // it as bound replaced every real term with null: a proposal card saying
  // "Not filled in yet" over a perfectly complete amendment.
  const bound = !!agreement
    && ["pattern", "cycle", "anchor_date"].some((column) => agreement[column] != null);
  const terms = bound ? {
    child_id: agreement.child_id,
    parent_a_id: agreement.parent_a_id,
    parent_b_id: agreement.parent_b_id,
    pattern: agreement.pattern,
    cycle: agreement.cycle,
    cycle_length: agreement.cycle_length,
    anchor_date: agreement.anchor_date,
    exchange_time: agreement.exchange_time,
    timezone: agreement.timezone,
    effective_from: agreement.effective_from,
    effective_to: agreement.effective_to,
    rationale: agreement.rationale,
    base_version_id: agreement.base_version_id,
    proposed_by: agreement.proposed_by,
  } : {};
  return {
    ...amendment,
    ...terms,
    id: agreement?.id ?? amendment.id,
    status,
    // Which seats exist, as opposed to which have signed: an empty second seat
    // is how a version agreed on one signature is told from one both signed.
    household_b_id: agreement?.household_b_id ?? amendment.household_b_id ?? null,
    household_a_agreed: agreement?.household_a_agreed ? 1 : 0,
    household_b_agreed: agreement?.household_b_agreed ? 1 : 0,
    agreed_at: agreement?.agreed_at ?? null,
    // Set only when the second parent signed AFTER the version took effect.
    countersigned_at: agreement?.countersigned_at ?? null,
  };
}

/**
 * The terms the hub froze onto an agreed version — the manifest's
 * `snapshot_columns`, pinned to it by a manifest test.
 *
 * Signing a version that is already in force means naming these back to the
 * hub exactly (`expected_snapshot`): the terms were bound by the other parent,
 * so repeating them is the only proof that this parent read what they sign.
 */
export const SCHEDULE_SNAPSHOT_COLUMNS = [
  "proposed_by", "child_id", "parent_a_id", "parent_b_id", "pattern", "cycle",
  "cycle_length", "anchor_date", "exchange_time", "timezone", "effective_from",
  "effective_to", "rationale", "base_version_id",
];

export function scheduleSnapshot(version) {
  return Object.fromEntries(SCHEDULE_SNAPSHOT_COLUMNS.map((column) => [column, version?.[column] ?? null]));
}

/**
 * How many parents actually signed an agreed version: "both" or "one".
 *
 * The hub locks a proposal on the proposer's signature alone when there is no
 * second party to ask — a household install, or a co-parenting space the other
 * parent has not joined yet. Such a version is in force, and it was NOT
 * countersigned; the app must never say it was. Read from the signatures on
 * the row, never from the status, which is `agreed` either way.
 */
export function versionSignatures(version) {
  return version?.household_a_agreed && version?.household_b_agreed ? "both" : "one";
}

/**
 * Where a member stands on a version that is in force on one signature:
 * "signer" (it is theirs), "unsigned_parent" (they are the other parent on it
 * and never signed), or null (countersigned, or not one of its two parents).
 *
 * The unsigned parent is the one person such a version can surprise: it took
 * effect before they were here, so they never saw it as a proposal. They are
 * told so, and pointed at the one remedy that exists — proposing a change.
 */
export function unilateralStance(version, memberId) {
  if (!version || !memberId || versionSignatures(version) === "both") return null;
  if (version.proposed_by === memberId) return "signer";
  return version.parent_a_id === memberId || version.parent_b_id === memberId ? "unsigned_parent" : null;
}

/**
 * Why the schedule form's timezone is not simply the space's, for the hint
 * under the field: "device" when it was taken from the proposer's own device
 * because the space had only UTC to offer, otherwise null.
 *
 * A zone nobody chose is still an agreed term once signed, so the proposer is
 * told where the default came from before they send it.
 */
export function timeZoneDefaultSource({ current = null, space = null, device = null } = {}) {
  if (current || (space && space !== "UTC")) return null;
  return device && device !== "UTC" ? "device" : null;
}

/**
 * The children a brand-new schedule can still be started for.
 *
 * A child who already has an agreed version, an open proposal, or this
 * parent's own draft is amended from their own row, where the form knows what
 * it is amending. Offering them under "Add child" as well produced a proposal
 * with no base version, which the hub refuses the moment its proposer signs it
 * (there is already a version in force) — after the proposal row was written.
 */
export function childrenOpenForNewSchedule(children, versions, drafts) {
  const taken = new Set([
    ...(versions || [])
      .filter((v) => v.status === "agreed" || v.status === "pending" || v.status === "draft")
      .map((v) => v.child_id),
    ...(drafts || []).map((d) => d.child_id),
  ]);
  return (children || []).filter((child) => !taken.has(child.id));
}

/** The version currently in force for a child, or null. */
export function agreedVersion(versions, childId) {
  return (versions || []).find((v) => v.status === "agreed" && v.child_id === childId) ?? null;
}

/** The open proposal for a child, or null. At most one can exist per child at a
 *  time in practice; the newest wins if a tenant somehow has two. */
export function openAmendment(versions, childId) {
  return (versions || [])
    .filter((v) => (v.status === "pending" || v.status === "draft") && v.child_id === childId)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0] ?? null;
}

/**
 * How an open proposal should read to `meId`.
 *
 * The app cannot see household ids — deliberately, since they are the hub's
 * business — so "which side am I" is derived from who proposed: the hub always
 * writes the PROPOSER's household into the first participant column. That is
 * exact for the ordinary two-parent case. It can be wrong only for a co-parent
 * seat that was demoted and refilled, where the new steward did not propose the
 * amendment they are now a party to; the consequence is a label, never an
 * authorization — the hub resolves the caller's real household on every act.
 *
 * `alreadySigned` is how that guess gets corrected. It is the hub's own answer,
 * returned by /api/agree as `already_agreed` when this side's consent was
 * on the row before the request. Without it a mis-sided view offers a
 * countersign button that reports success and changes nothing, forever; with
 * it, one click settles the question the app cannot answer by itself. It is
 * only ever an override toward "signed" — a guess is never promoted to a fact
 * in the direction that would offer MORE authority.
 *
 * @returns {"awaiting_them"|"awaiting_you"|"unsigned"}
 */
export function amendmentStance(amendment, meId, alreadySigned = false) {
  if (!amendment) return "unsigned";
  if (alreadySigned) return "awaiting_them";
  const iProposed = amendment.proposed_by === meId;
  const mine = iProposed ? amendment.household_a_agreed : amendment.household_b_agreed;
  const theirs = iProposed ? amendment.household_b_agreed : amendment.household_a_agreed;
  if (mine && !theirs) return "awaiting_them";
  if (!mine) return "awaiting_you";
  return "unsigned";
}

/**
 * Who must be told about a standing-schedule change.
 *
 * NOT the pairing. Pairing is an in-app act that exists to open the private
 * message log, and it is entirely possible — common, even, early on — for two
 * co-parents to be full members of the space without having completed it. A
 * schedule amendment routed through the pairing would then reach nobody, which
 * is precisely the failure the plan forbids: "do not depend on partner
 * notification configuration to make a material change visible; use the space
 * membership/co-parent relationship as the delivery source."
 *
 * So the audience is derived from membership. The other co-parent is an adult
 * with a login who is an admin — the derived-role definition, as far as
 * `family.members` can see it (it deliberately exposes no home household). If
 * that yields nobody, this falls back to every other adult rather than
 * returning empty: for ACCESS, ambiguity must fail closed, but for a
 * NOTIFICATION about a change the recipient can already read, failing closed
 * means silence, and silence is the bug being fixed.
 */
export function scheduleNoticeAudience(members, meId) {
  const others = (members || []).filter((m) => m.id !== meId && m.role === "adult");
  const stewards = others.filter((m) => m.isAdmin && m.hasLogin !== false);
  return (stewards.length ? stewards : others).map((m) => m.id);
}

/** Whether `meId` may still record consent on this proposal. */
export function canSignAmendment(amendment, meId, alreadySigned = false) {
  if (!amendment || (amendment.status !== "pending" && amendment.status !== "draft")) return false;
  return amendmentStance(amendment, meId, alreadySigned) !== "awaiting_them";
}

/**
 * A human phrase for what an amendment changes about the version it amends, or
 * null when it changes nothing meaningful.
 *
 * Shown to the parent being asked to sign. `cycle_length` is deliberately not
 * listed: it is derived from `cycle` and would double-report every edit.
 */
const SCHEDULE_FIELD_LABELS = [
  ["pattern", "the rotation pattern"],
  ["cycle", "the custom cycle"],
  ["anchor_date", "the cycle start date"],
  ["parent_a_id", "which parent is Parent A"],
  ["parent_b_id", "which parent is Parent B"],
  ["exchange_time", "the exchange time"],
  ["timezone", "the timezone custody days are counted in"],
  ["effective_from", "when it starts"],
  ["effective_to", "when it ends"],
];

/** Join a list the way a person would: "a", "a and b", "a, b and c". */
export function joinPhrases(parts) {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The changed-fields phrase itself. Null means nothing meaningful moved, which
 * the caller uses to refuse a no-op proposal rather than ask the other parent
 * to countersign an identical schedule.
 */
export function describeScheduleChange(before, after) {
  if (!before) return null;
  const changed = SCHEDULE_FIELD_LABELS
    .filter(([field]) => (before[field] ?? null) !== (after[field] ?? null))
    .map(([, label]) => label);
  return changed.length ? joinPhrases(changed) : null;
}

// ── Private schedule drafts ─────────────────────────────────────────────────

/**
 * The terms a set of schedule fields would propose, in the exact shape
 * `/api/propose-agreement` takes. `fields` is a saved draft row or the schedule
 * form's current values — the same function either way.
 *
 * This exists so that "send my draft" and "propose a change from the form" go
 * through ONE definition of what a proposal's terms are. A draft that compiles
 * differently from the form it was typed into is a draft that proposes
 * something its author never saw.
 *
 * `effective_from`/`effective_to` are always null here, and deliberately not
 * inherited from the version being amended. The form has no field for either,
 * so an inherited value is one the proposer never saw: amending a schedule that
 * had been ended carried its past end date forward, and both parents then
 * countersigned a rotation that published no days at all. Ending a schedule is
 * its own act (the retirement proposal), the only place an end date is set.
 *
 * `cycle` is stored already-compiled — the canonical day-by-day 'a'/'b' array,
 * not the pattern name — because that array is what gets countersigned, and a
 * later release changing what "two_two_three" means must not silently change
 * what a saved draft would propose.
 *
 * Returns null when the draft is not proposable yet (the required terms of the
 * agreement are missing), so a half-finished draft can be saved and reopened
 * without ever becoming a sendable proposal by accident.
 */
export function scheduleProposalTerms(draft, fallbackTimezone) {
  if (!draft) return null;
  const cycle = normalizeCycle(draft.cycle);
  const timezone = draft.timezone || fallbackTimezone || null;
  const required = [draft.child_id, draft.parent_a_id, draft.parent_b_id, draft.pattern, draft.anchor_date, timezone];
  if (required.some((value) => !value) || !cycle.length) return null;
  if (draft.parent_a_id === draft.parent_b_id) return null;
  return {
    child_id: draft.child_id,
    parent_a_id: draft.parent_a_id,
    parent_b_id: draft.parent_b_id,
    pattern: draft.pattern,
    cycle: JSON.stringify(cycle),
    cycle_length: cycle.length,
    anchor_date: draft.anchor_date,
    exchange_time: draft.exchange_time || null,
    timezone,
    effective_from: null,
    effective_to: null,
    rationale: draft.rationale || null,
    base_version_id: draft.base_version_id ?? null,
  };
}

/** The name the draft lane has always called it by. Same function. */
export const draftProposalTerms = scheduleProposalTerms;

/**
 * Why a draft cannot be sent yet, as a sentence, or null when it can.
 *
 * A draft is allowed to be incomplete — that is what makes it a draft — so this
 * is a send-time check, never a save-time one.
 *
 * "Stale" is the case worth naming out loud: the draft was written against one
 * agreed version and the other parent has since countersigned a different one.
 * Sending it anyway would propose reverting their change while looking like an
 * ordinary edit, so the author is told to re-open it against what is now in
 * force rather than being quietly rebased.
 */
export function draftSendBlocker(draft, agreed, fallbackTimezone) {
  if (!draft) return "There is no draft to send.";
  if (!draftProposalTerms(draft, fallbackTimezone)) {
    return "This draft is missing something — open it and finish the pattern, start date and parents.";
  }
  const base = draft.base_version_id ?? null;
  const inForce = agreed?.id ?? null;
  if (base !== inForce) {
    return agreed
      ? "The schedule changed after you started this draft. Open it to check it against what is in force now."
      : "The schedule this draft was based on is no longer in force. Open it to check it.";
  }
  if (agreed && !describeScheduleChange(agreed, draftProposalTerms(draft, fallbackTimezone))) {
    return "This draft matches the schedule already in force, so there is nothing to propose.";
  }
  return null;
}

// ── Swap-request validation ─────────────────────────────────────────────────

/**
 * Validate a proposed swap before writing it. Returns { ok: true } or
 * { ok: false, error }. Pure — the caller supplies today's date so this stays
 * deterministic and testable.
 *
 * `opts.schedule` is the child's agreed version. When given, the swap must be
 * between that version's two parents, inside its effective window (see
 * swapPartyIssue — an app-side check, not the enforcement). `opts.horizonDays`
 * bounds how far ahead it may start; see SWAP_HORIZON_DAYS.
 */
export function validateSwap(swap, todayStr, opts = {}) {
  const horizonDays = opts.horizonDays ?? SWAP_HORIZON_DAYS;
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
  // The hub only projects this far, and refuses to lock a swap that moves no
  // projected day — so one that starts beyond it could be requested and never
  // agreed. Refused where the dates are picked, not on the other parent's
  // countersignature.
  if (todayStr && toDayNumber(swap.start_date) > toDayNumber(todayStr) + horizonDays) {
    return {
      ok: false,
      error: `A swap can start at most ${horizonDays} days ahead (by ${addDays(todayStr, horizonDays)}) — `
        + "the calendar is only worked out that far. Ask again closer to the date.",
    };
  }
  if (opts.schedule !== undefined) {
    const issue = swapPartyIssue(swap, opts.schedule);
    if (issue) return { ok: false, error: issue };
    if (todayStr && scheduleHasEnded(opts.schedule, todayStr)) {
      return { ok: false, error: "This child's schedule has ended, so there is nothing for a swap to change." };
    }
    if (!withinEffectiveWindow(opts.schedule, swap.start_date) || !withinEffectiveWindow(opts.schedule, swap.end_date)) {
      return { ok: false, error: "Those dates fall outside the agreed schedule." };
    }
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

/**
 * The other party on a message, from `meId`'s perspective. The one rule for
 * "who was this exchanged with" — the thread partition and the UI's
 * history checks must never disagree about it.
 */
export function counterpartOf(message, meId) {
  return (message.author_id === meId ? message.recipient_id : message.author_id) ?? null;
}

/**
 * Which of the four pairing states the app should show.
 *
 * "awaiting" and "ended" both look like "I named them, they don't name me
 * back" from the pairing row alone, so the hub says which one it is:
 * `proposal_pending` is true while the caller's own proposal is live (their
 * row still carries the session it was minted with) and false once the other
 * side tore the pairing down (that path clears the session). Message history
 * deliberately plays no part — it cannot tell a live re-proposal to a former
 * co-parent from the ended pairing it follows, and both misreadings are cruel:
 * one tells a parent to wait forever, the other tells them a pairing they just
 * proposed is already over.
 *
 * @param proposalPending the hub's `proposal_pending` for the caller
 * @returns {"unpaired"|"awaiting"|"ended"|"active"}
 */
export function pairingState({ partnerId, reciprocal, proposalPending }) {
  if (!partnerId) return "unpaired";
  if (reciprocal) return "active";
  return proposalPending ? "awaiting" : "ended";
}

/**
 * Split a message log into the CURRENT pairing's record and earlier ones.
 *
 * A parent keeps every message that names them, for as long as retention says
 * — including the record of a co-parent relationship that has since ended. Run
 * together in one thread those read as a single conversation with the person
 * you are paired with today, which is wrong and, for a record both parents may
 * rely on, misleading.
 *
 * A message belongs to the current pairing exactly when it carries the current
 * session id: the hub stamps one onto every message it accepts, and there is
 * no current session unless the pairing is reciprocal. Everything else —
 * including the record of a pairing that just ended, while no new one is
 * live — groups by the other party, so one person's history stays contiguous
 * even across several of their own past sessions.
 *
 * (The app shipped with no installed base, so no message predates session
 * stamping; a null session id never occurs and simply files as "earlier".)
 *
 * @returns {{ current: object[], earlier: Array<{ counterpartId: string|null, messages: object[] }> }}
 *   `earlier` is grouped by the other party, most recent group first.
 */
export function partitionMessagesBySession(messages, meId, sessionId) {
  const current = [];
  const groups = new Map();   // counterpartId -> { messages, latest }
  for (const message of messages ?? []) {
    if (sessionId && message.session_id === sessionId) { current.push(message); continue; }
    const key = counterpartOf(message, meId);
    let group = groups.get(key);
    if (!group) { group = { messages: [], latest: "" }; groups.set(key, group); }
    group.messages.push(message);
    // Tracked while bucketing: the renderer re-partitions on every keystroke
    // of the search box, so the comparator must not rescan each group.
    if ((message.sent_at ?? "") > group.latest) group.latest = message.sent_at;
  }
  const earlier = [...groups.entries()]
    .map(([counterpartId, group]) => ({ counterpartId, messages: group.messages, latest: group.latest }))
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .map(({ counterpartId, messages: list }) => ({ counterpartId, messages: list }));
  return { current, earlier };
}
