import { describe, it, expect } from "vitest";
import { failureLine, agreementRowState, agreementFailureLine, outcomeUnknown, storedDiffers } from "../src/logic.js";

const err = (props, message = "hub text") => Object.assign(new Error(message), props);
const words = { action: "save the draft", thing: "draft" };

describe("failureLine", () => {
  it("names a duplicate by code, or by the hub's text while production lags", () => {
    expect(failureLine(err({ status: 400, code: "UNIQUE_CONSTRAINT" }), words)).toBe("That draft already exists.");
    expect(failureLine(err({ status: 400 }, "UNIQUE constraint failed: x.id"), words)).toBe("That draft already exists.");
  });
  it("names a refusal without asking for a retry", () => {
    expect(failureLine(err({ status: 403 }), words)).toBe("You don’t have permission to save the draft.");
    expect(failureLine(err({ status: 507 }), words)).toBe("The household’s storage is full — free up space first.");
    expect(failureLine(err({ status: 429 }), words)).toBe("Too many tries — wait a minute and try again.");
  });
  it("splits a write that changed nothing by the caller's re-read", () => {
    expect(failureLine(null, { ...words, found: false })).toBe("This draft has been removed.");
    expect(failureLine(null, { ...words, found: true })).toBe("You don’t have permission to save the draft.");
  });
  it("reads a 404 as removed and a 409 as changed", () => {
    expect(failureLine(err({ status: 404 }), words)).toBe("This draft has been removed.");
    expect(failureLine(err({ status: 409 }), words)).toBe("This draft was changed by someone else — check it first.");
  });
  it("asks for a retry only when retrying can work", () => {
    for (const e of [err({}), err({ status: 500 }), err({ status: 503 }), err({ status: 400 }), err({ status: 200 }), new TypeError("Failed to fetch"), undefined]) {
      expect(failureLine(e, words)).toBe("Couldn’t save the draft — try again.");
    }
  });
  it("keeps a line the app wrote for the user, and never shows hub text", () => {
    expect(failureLine(err({ forUser: true }, "Pick a child."), words)).toBe("Pick a child.");
    expect(failureLine(err({ status: 500 }, "D1_ERROR: boom"), words)).not.toMatch(/D1_ERROR/);
  });
});

describe("agreementRowState", () => {
  it("knows nothing when the re-read failed", () => {
    expect(agreementRowState({ status: "pending" }, { readOk: false })).toBeUndefined();
    expect(agreementRowState(undefined, { readOk: false })).toBeUndefined();
  });
  it("tells a gone row, an open one, and one that moved on", () => {
    expect(agreementRowState(undefined, { readOk: true })).toBe("gone");
    expect(agreementRowState({ status: "pending" }, { readOk: true })).toBe("open");
    // No agreement row yet: the hub has not bootstrapped it, so still pending.
    expect(agreementRowState({ status: "draft" }, { readOk: true })).toBe("open");
    for (const status of ["agreed", "declined", "withdrawn", "superseded", "locked", "cancelled"]) {
      expect(agreementRowState({ status }, { readOk: true })).toBe("answered");
    }
  });
  it("against the version in force, anything else means it was replaced", () => {
    expect(agreementRowState({ status: "agreed" }, { readOk: true, open: "agreed" })).toBe("open");
    expect(agreementRowState({ status: "superseded" }, { readOk: true, open: "agreed" })).toBe("replaced");
  });
});

describe("agreementFailureLine", () => {
  const sign = { action: "countersign this change", thing: "proposal" };

  it("says when the proposal was already answered, for a refusal", () => {
    expect(agreementFailureLine(err({ status: 400 }), { ...sign, state: "answered" })).toBe("This proposal was already answered.");
    expect(agreementFailureLine(err({ status: 409 }), { ...sign, state: "answered" })).toBe("This proposal was already answered.");
  });
  it("names the open-proposals cap from its code; a plain 409 stays neutral", () => {
    const propose = { action: "send this schedule", thing: "proposal" };
    expect(agreementFailureLine(err({ status: 409, code: "proposal_limit" }), propose))
      .toBe("You have too many proposals waiting — withdraw one first.");
    expect(agreementFailureLine(err({ status: 409 }), propose))
      .toBe("Something changed while you had this open — check it first.");
  });
  it("says when the version in force was replaced", () => {
    expect(agreementFailureLine(err({ status: 409 }), { action: "countersign this schedule", thing: "custody schedule", state: "replaced" }))
      .toBe("This custody schedule is no longer the one in force — check the current one.");
  });
  it("names removed, permission, storage and too many tries", () => {
    expect(agreementFailureLine(err({ status: 404 }), sign)).toBe("This proposal has been removed.");
    expect(agreementFailureLine(err({ status: 400 }), { ...sign, state: "gone" })).toBe("This proposal has been removed.");
    expect(agreementFailureLine(err({ status: 403 }), sign)).toBe("You don’t have permission to countersign this change.");
    expect(agreementFailureLine(err({ status: 507 }), sign)).toBe("The household’s storage is full — free up space first.");
    expect(agreementFailureLine(err({ status: 429 }), sign)).toBe("Too many tries — wait a minute and try again.");
  });
  it("tells a busy schedule (409 with Retry-After) from a moved one", () => {
    expect(agreementFailureLine(err({ status: 409, retryAfter: true }), { ...sign, state: "open" }))
      .toBe("Another change to this schedule is being applied — try again in a moment.");
    expect(agreementFailureLine(err({ status: 409 }), { ...sign, state: "open" }))
      .toBe("Something changed while you had this open — check it first.");
  });
  it("does not trust a re-read after no answer or a hub failure: the move may be this parent's own", () => {
    for (const e of [err({}), err({ status: 500 }), err({ status: 503 }), new TypeError("Failed to fetch")]) {
      for (const state of ["answered", "gone", "replaced", "open", undefined]) {
        expect(agreementFailureLine(e, { ...sign, state })).toBe("Couldn’t countersign this change — try again.");
      }
    }
  });
  it("asks for a retry on a 400 while the proposal is still open", () => {
    expect(agreementFailureLine(err({ status: 400 }), { ...sign, state: "open" })).toBe("Couldn’t countersign this change — try again.");
    expect(agreementFailureLine(err({ status: 400 }), sign)).toBe("Couldn’t countersign this change — try again.");
  });
  it("keeps a line the app wrote for the user, and never shows hub text", () => {
    expect(agreementFailureLine(err({ forUser: true }, "Pick a child."), sign)).toBe("Pick a child.");
    expect(agreementFailureLine(err({ status: 409 }, "Row is no longer pending"), sign)).not.toMatch(/Row is/);
  });
});

describe("outcomeUnknown", () => {
  it("is unknown with no answer, a 400, or a hub failure", () => {
    for (const e of [err({}), new TypeError("Failed to fetch"), undefined, err({ status: 400 }), err({ status: 500 }), err({ status: 503 })]) {
      expect(outcomeUnknown(e)).toBe(true);
    }
  });
  it("is known for a refusal or a full store", () => {
    for (const status of [403, 404, 409, 429, 507]) expect(outcomeUnknown(err({ status }))).toBe(false);
  });
});

describe("storedDiffers", () => {
  it("compares the form's columns as text, missing as empty", () => {
    expect(storedDiffers({ cycle_length: 14, rationale: null, extra: "x" }, { cycle_length: "14", rationale: "" })).toBe(false);
    expect(storedDiffers({ anchor_date: "2026-01-05" }, { anchor_date: "2026-01-12" })).toBe(true);
    expect(storedDiffers(undefined, { pattern: "custom" })).toBe(true);
  });
});
