import { readFileSync, existsSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const entrypoint = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

const VALID_STORAGE   = ["kv", "db", "none"];
const VALID_AUDIENCES = ["everyone", "adults", "children"];

describe("manifest.json", () => {
  it("has required string fields", () => {
    for (const field of ["id", "name", "version", "description", "entrypoint", "runtime", "icon"]) {
      expect(manifest[field], `missing field: ${field}`).toBeTruthy();
    }
  });

  it("entrypoint is index.html", () => expect(manifest.entrypoint).toBe("index.html"));
  it("runtime is static",        () => expect(manifest.runtime).toBe("static"));

  it("storage is declared and valid", () => {
    expect(manifest.storage, "storage field is required").toBeTruthy();
    expect(VALID_STORAGE).toContain(manifest.storage);
  });

  it("version follows semver", () => expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/));

  it("permissions.default_audience is valid", () => {
    expect(VALID_AUDIENCES).toContain(manifest.permissions.default_audience);
  });

  it("permissions.requires_approval is boolean", () => {
    expect(typeof manifest.permissions.requires_approval).toBe("boolean");
  });

  it("data_access has reads and writes arrays", () => {
    expect(Array.isArray(manifest.data_access.reads)).toBe(true);
    expect(Array.isArray(manifest.data_access.writes)).toBe(true);
  });

  it("makes declined and cancelled swap requests terminal for agreement locking", () => {
    expect(manifest.agreements.swap_agreements).toMatchObject({
      init_from_table: "swap_requests",
      resolution_values: {
        requester_id: "cancelled",
        responder_id: "declined",
      },
    });
  });

  // A ratchet, and the whole feature rests on it. `owner_only` normally lets
  // ADULTS read other members' rows (supervision) — and in a co-parenting space
  // the other parent is an adult and a steward. Drop `adults_bypass: false` and
  // the private draft becomes readable by precisely the person it is private
  // from, with no error and no visible change: the UI would go on saying "only
  // you can see this" while it was no longer true.
  it("keeps schedule drafts readable only by their author", () => {
    expect(manifest.row_policies.schedule_drafts).toMatchObject({
      kind: "owner_only",
      member_column: "author_id",
      adults_bypass: false,
    });
  });

  // A draft is a working copy, not a history. The cap is what makes "saving
  // updates the draft" a rule the database enforces rather than a convention
  // the app happens to follow.
  it("caps drafts at one per parent per child", () => {
    expect(manifest.row_policies.schedule_drafts.max_per_member).toEqual({
      member_column: "author_id",
      scope_columns: ["child_id"],
      limit: 1,
    });
  });

  // Nobody but the author can read a draft, so a departed author's draft has no
  // audience at all — retaining it would keep private working notes about a
  // child alive with no one entitled to see them.
  it("removes a draft with its author or its child", () => {
    const refs = Object.fromEntries(
      manifest.member_references.schedule_drafts.map(r => [r.column, r.on_removed]));
    expect(refs.author_id).toBe("delete");
    expect(refs.child_id).toBe("delete");
  });

  // A ratchet, not a preference. `schedule_versions.rationale` is one parent's
  // written argument for changing custody — the single most sensitive field in
  // the table — and `read: "everyone"` put it in front of every child in the
  // space and every future professional guest. The projection children actually
  // need is `custody_days`, which stays readable to them.
  it("keeps the agreed-schedule terms adult-read and the projection member-read", () => {
    expect(manifest.row_policies.schedule_versions.read).toBe("adult");
    expect(manifest.row_policies.schedule_amendments.read).toBe("adult");
    expect(manifest.row_policies.custody_days.read).toBe("everyone");
  });

  // The adult view bails out when `schedules` is empty, so tightening the read
  // above would have left a child with a blank app if nothing rendered the
  // projection instead.
  it("falls back to the custody_days projection when no version is readable", () => {
    expect(entrypoint).toMatch(/if \(custodyDays\.length\) \{ renderProjectedSchedule\(el\); return; \}/);
    expect(entrypoint).toMatch(/function renderProjectedSchedule\(el\)/);
  });

  it("imports every Phase 4 pairing helper used by the browser entrypoint", () => {
    const logicImport = entrypoint.match(/import\s*\{([\s\S]*?)\}\s*from\s*["']\.\/logic\.js["']/)?.[1] ?? "";
    expect(logicImport).toMatch(/\bpairingState\b/);
  });
});

// ── Numbers and statements the app and the manifest must agree on ─────────────
// The app cannot read its own manifest at runtime, so each of these lives in
// two places by necessity. Pinned here so they cannot drift apart silently.
describe("manifest ↔ app agreement", async () => {
  const { SWAP_HORIZON_DAYS, CUSTODY_LOOKBACK_DAYS, SCHEDULE_SNAPSHOT_COLUMNS, HOLIDAY_SNAPSHOT_COLUMNS } = await import("../src/logic.js");

  // A swap starting beyond the projection horizon can be requested and never
  // countersigned — the hub refuses to lock one that moves no projected day.
  it("bounds swaps by the projection horizon", () => {
    expect(SWAP_HORIZON_DAYS).toBe(manifest.cycle_projection.horizon_days);
  });

  // `custody_days` grows by a row per child per day for as long as retention
  // keeps them. An unbounded first read outgrows the hub's inline cap, at which
  // point the WHOLE preload is discarded on every launch.
  it("preloads a window of custody days around today, never the table", () => {
    const { sql, params } = manifest.preload.custody_days;
    expect(sql).toContain(`WHERE day >= date(?, '-${CUSTODY_LOOKBACK_DAYS} days')`);
    expect(params).toEqual([":today"]);
  });

  it("reads custody days nowhere without a lower bound on the day", () => {
    const reads = entrypoint.match(/SELECT \* FROM (?:app_co_parenting__|\$\{P\})custody_days[^"`]*/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read, read).toMatch(/day >= /);
  });

  // The report binds the caller's `to` verbatim, and "2026-10-31T09:00Z" sorts
  // AFTER "2026-10-31" — so a plain end date silently dropped its whole last
  // day from any view filtered on a timestamp.
  it("includes the whole end day in every report filtered on a timestamp", () => {
    const stamped = manifest.reports.views.filter((v) => /_at >= :range_start/.test(v.source.query)).map((v) => v.id);
    expect(stamped.sort()).toEqual(["holiday_schedule", "standing_schedule", "swap_requests"]);
    for (const id of stamped) {
      const query = manifest.reports.views.find((v) => v.id === id).source.query;
      expect(query, id).toMatch(/substr\([\w.]+_at, 1, 10\) <= substr\(:range_end, 1, 10\)/);
      expect(query, id).not.toMatch(/_at <= :range_end/);
    }
  });

  // The parents' conversation is the space's own Messages. The app keeps no
  // copy and no second inbox: it asks the hub to print the conversations in
  // the full record, and links to the thread.
  it("leaves messages to the hub and asks for them in the full record", () => {
    expect(manifest.reports.conversations).toBe(true);
    expect(manifest.paired_messages).toBeUndefined();
    expect(manifest.reports.views.map((v) => v.id)).not.toContain("message_log");
    expect(JSON.stringify(manifest)).not.toMatch(/__messages\b/);
  });

  // No household ran the old schema, so the table is gone from the migrations
  // themselves instead of surviving as a sealed leftover.
  it("has no messages table anywhere in its schema", () => {
    expect(manifest.row_policies.messages).toBeUndefined();
    expect(manifest.member_references.messages).toBeUndefined();
    const dir = join(__dirname, "../migrations");
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), "utf-8"), file).not.toMatch(/co_parenting__messages/);
    }
  });

  it("has no message write or read path of its own in the entrypoint", () => {
    expect(entrypoint).not.toMatch(/api\/paired-message/);
    expect(entrypoint).not.toMatch(/co_parenting__messages|\$\{P\}messages/);
  });

  // The pairing still names the swap counterparty, so it survives the move.
  it("keeps the pairing that swaps and notifications rely on", () => {
    expect(manifest.partner_link.table).toBe("partner_config");
    expect(manifest.row_policies.partner_config.kind).toBe("owner_only");
  });

  it("builds the Messages link from the tested rules, and marks it as leaving the app", () => {
    expect(entrypoint).toContain("const href = hubMessagesUrl(HUB_ORIGIN, coParent?.id);");
    expect(entrypoint).toMatch(/data-testid="open-messages"[^>]*target="_top"/);
  });

  // A holiday schedule moves custody days, so it is held to what the standing
  // schedule is: an agreement both households sign, written only by the hub,
  // one version in force per child, projected only once locked.
  it("makes the holiday schedule a countersigned agreement the hub projects beneath swaps", () => {
    const agreement = manifest.agreements.holiday_versions;
    const standing = manifest.agreements.schedule_versions;
    expect(agreement.party_mode).toBe("steward_households");
    expect(agreement.participant_columns).toEqual(standing.participant_columns);
    expect(agreement.locked_value).toBe("agreed");
    expect(agreement.init_from_table).toBe("holiday_amendments");
    expect(agreement.version_series.scope_columns).toEqual(["child_id"]);
    expect(agreement.snapshot_columns).toEqual(expect.arrayContaining(["child_id", "parent_a_id", "parent_b_id", "rules"]));
    for (const table of ["holiday_amendments", "holiday_versions"]) {
      expect(manifest.row_policies[table]).toMatchObject({ kind: "endpoint_only", read: "adult", audit_writes: true });
    }
    const recurring = manifest.cycle_projection.recurring_exceptions;
    expect(recurring).toMatchObject({
      table: "holiday_versions", status_column: agreement.status_column, active_value: agreement.locked_value,
      scope_column: "child_id", rules_column: "rules",
    });
    expect(recurring.party_columns).toEqual(manifest.cycle_projection.party_columns);
    expect(recurring.table).not.toBe(manifest.cycle_projection.exceptions.table);
    expect(manifest.db_plaintext_columns).toContain("rules");
  });

  // The Handoffs tab reads the clock out of a transition's subtitle by
  // stripping "Handoff " — so a holiday handoff must keep the ordinary
  // transition subtitle, and the holiday's name goes in the title instead.
  it("keeps the handoff subtitle parseable on a holiday", () => {
    const t = manifest.cycle_projection.templates;
    expect(t.holiday_transition_subtitle).toBeUndefined();
    expect(t.transition_subtitle).toBe("Handoff {time}");
    expect(t.holiday_title).toContain("{label}");
    expect(t.holiday_transition_title).toContain("{label}");
  });

  // The custody journal is testimony: append-only through the endpoint, adult
  // read, kept as long as the custody record it is read against, and never
  // countersigned — an agreement would let one parent keep the other's account
  // off the record.
  it("keeps the custody journal append-only, adult-read, and retained like the custody record", () => {
    const policy = manifest.row_policies.custody_log;
    expect(policy).toMatchObject({ kind: "endpoint_only", read: "adult", audit_writes: true });
    expect(manifest.retention.custody_log).toMatchObject({ default: 400, timestamp_column: "day", tier: "evidentiary" });
    // A photo is added after its entry, possibly long after a backdated one, so
    // its own created_at clock runs later: the entry's expiry takes its photos
    // (and their bytes) with it rather than leaving them orphaned.
    expect(manifest.retention.custody_log.dependent_tables).toEqual([
      { table: "journal_photos", foreign_key: "entry_id", file_id_column: ["photo_file_id", "thumb_file_id"] },
    ]);
    expect(manifest.retention.custody_days.default).toBe(manifest.retention.custody_log.default);
    const rec = manifest.append_only_records.custody_log;
    expect(rec.write_acl).toEqual({ require_role: "adult" });
    expect(rec.required_columns).toEqual(["child_id", "day", "kind"]);
    expect(rec.allowed_values.kind).toEqual(["exchange_as_planned", "exchange_late", "exchange_missed"]);
    // A record of what happened: the hub refuses a day that has not begun.
    expect(rec.value_formats).toEqual({ day: "date_not_future", actual_time: "time" });
    // "Where the child was" names a parent or is not recorded at all.
    const facts = manifest.append_only_records.custody_facts;
    expect(facts).toMatchObject({ table: "custody_log", write_acl: { require_role: "adult" }, value_formats: { day: "date_not_future" } });
    expect(facts.allowed_values.kind).toEqual(["child_with"]);
    expect(facts.required_columns).toContain("parent_id");
    expect(rec.allowed_columns).not.toContain("parent_id");
    // An account cannot be written as an answer, and an answer cannot be
    // written without naming a real entry: answers have a record of their own
    // whose parent check the hub runs before and inside the insert.
    expect(rec.allowed_columns).not.toContain("responds_to_id");
    const answers = manifest.append_only_records.custody_answers;
    expect(answers).toMatchObject({
      table: "custody_log", parent_table: "custody_log", parent_fk_column: "responds_to_id",
      write_acl: { require_role: "adult" },
    });
    expect(answers.allowed_values.kind).toEqual(["acknowledge", "dispute"]);
    // Only an exchange account is answerable — never an answer, never a fact,
    // and not a journal note until the app draws answers under notes.
    expect(answers.parent_status_column).toBe("kind");
    expect(answers.parent_blocked_status_values).toEqual(["acknowledge", "dispute", "child_with", "note", "exchange_checkin"]);
    expect(answers.value_formats).toEqual({ day: "date_not_future" });
    expect(answers.required_columns).toContain("responds_to_id");
    expect(answers.allowed_columns).not.toContain("parent_id");
    expect(manifest.agreements.custody_log).toBeUndefined();
    for (const col of ["day", "kind", "actual_time"]) expect(manifest.db_plaintext_columns).toContain(col);
  });

  it("says in the exchange log WHICH entry an answer answers, not only whose", () => {
    const view = manifest.reports.views.find((v) => v.id === "exchange_log");
    expect(view.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["answers", "answers_kind", "answers_recorded_at"]));
    expect(view.columns.length).toBeLessThanOrEqual(12);
    // Filed under the exchange it answers, whatever day the answer itself carries.
    expect(view.source.query).toContain("COALESCE(r.day, l.day) AS day");
  });

  it("reports the journal through two adult views that children cannot read", () => {
    const ids = manifest.reports.views.map((v) => v.id);
    expect(ids).toContain("exchange_log");
    expect(ids).toContain("custody_actuals");
    for (const id of ["exchange_log", "custody_actuals"]) {
      const view = manifest.reports.views.find((v) => v.id === id);
      expect(view.source.query).toContain("app_co_parenting__custody_log");
      expect(view.source.query).toMatch(/l\.day >= :range_start AND l\.day <= :range_end/);
    }
  });

  // `swap_requests.status` is never told about a lock and stays editable; the
  // agreement row is the record of how a swap was answered.
  it("reports a swap's outcome from the agreement, not the request", () => {
    const query = manifest.reports.views.find((v) => v.id === "swap_requests").source.query;
    expect(query).toContain("LEFT JOIN app_co_parenting__swap_agreements a ON a.id = r.id");
    expect(query).toContain("COALESCE(a.status, r.status) AS status");
  });

  // A version the hub locked on one signature is `agreed` like any other, so
  // the report has to read the signatures or it presents a unilateral schedule
  // as one both parents signed.
  it("reports how many parents signed each standing schedule, and never calls the date 'countersigned'", () => {
    const view = manifest.reports.views.find((v) => v.id === "standing_schedule");
    // Carried in the State column: the hub caps a view at twelve columns and
    // this one already has twelve.
    expect(view.source.query).toContain(
      "status || CASE WHEN household_a_agreed = 1 AND household_b_agreed = 1 THEN ', signed by both parents' ELSE ', signed by one parent' END");
    // A signature added after the schedule took effect is dated, so the record
    // never reads as though both parents had signed from the start.
    expect(view.source.query).toContain(
      "CASE WHEN countersigned_at IS NOT NULL THEN ' (second signature ' || substr(countersigned_at, 1, 10) || ')' ELSE '' END AS state");
    expect(view.columns.map((c) => c.key)).toContain("state");
    expect(view.columns.length).toBeLessThanOrEqual(12);
    expect(view.columns.find((c) => c.key === "agreed_at").label).not.toMatch(/countersigned/i);
  });

  // The description is what the catalog and the install screen show. It may
  // not promise a countersignature the hub does not ask for before the second
  // parent has joined.
  it("describes the one-signature case rather than promising both parents always sign", () => {
    expect(manifest.description).toContain("once both have joined");
    expect(manifest.description).toContain("in force on one signature");
    expect(manifest.description).not.toMatch(/BOTH parents countersign before they take effect/);
  });

  // The late signature has to name the frozen terms exactly as the hub holds
  // them, column for column, or the hub refuses it.
  it("signs a schedule already in force against exactly the manifest's snapshot columns", () => {
    const config = manifest.agreements.schedule_versions;
    expect([...SCHEDULE_SNAPSHOT_COLUMNS].sort()).toEqual([...config.snapshot_columns].sort());
    expect(config.late_signature).toEqual({ signed_at_column: "countersigned_at" });
    const migration = readFileSync(join(__dirname, "../migrations/008_schedule_countersigned_at.sql"), "utf-8");
    expect(migration).toContain("ADD COLUMN countersigned_at TEXT");
  });

  it("signs a holiday schedule already in force against exactly the manifest's snapshot columns", () => {
    const config = manifest.agreements.holiday_versions;
    expect([...HOLIDAY_SNAPSHOT_COLUMNS].sort()).toEqual([...config.snapshot_columns].sort());
    expect(config.late_signature).toEqual({ signed_at_column: "countersigned_at" });
    const migration = readFileSync(join(__dirname, "../migrations/010_holiday_schedules.sql"), "utf-8");
    expect(migration).toMatch(/holiday_versions \([^;]*countersigned_at\s+TEXT/);
  });

  // The reports a parent hands over on their own. The hub puts the signed
  // day-by-day array and each holiday rule into words; proposals ride along
  // marked as not in force, so a draft can go to a lawyer before it is signed.
  // Two reports, not one: a report may read one policy-governed table (the
  // hub refuses a governed table inside a CTE or subquery, and a top-level
  // UNION), and the standing schedule and the holidays are two agreements.
  it("offers the agreed schedule and the agreed holidays as hub-worded reports, per child", () => {
    expect(manifest.reports.views.slice(0, 2).map((v) => v.id)).toEqual(["agreed_schedule", "agreed_holidays"]);
    const schedule = manifest.reports.views.find((v) => v.id === "agreed_schedule");
    const holidays = manifest.reports.views.find((v) => v.id === "agreed_holidays");
    expect(schedule.columns.find((c) => c.key === "rotation").format).toBe("schedule_cycle");
    expect(holidays.columns.find((c) => c.key === "falls").format).toBe("recurring_rule");
    // The rotation column carries the stored array and its anchor for the hub
    // to word; the array stays a JSON string inside, so an unreadable one is
    // printed as-is rather than failing the document.
    expect(schedule.source.query).toContain("json_object('cycle', cycle, 'anchor_date', anchor_date, 'a', 'Parent A', 'b', 'Parent B') AS rotation");
    expect(schedule.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["effective_from", "effective_to"]));
    for (const view of [schedule, holidays]) {
      expect(view.group_by).toBe("child");
      expect(view.columns.length).toBeLessThanOrEqual(12);
      const { query } = view.source;
      expect(query.length).toBeLessThanOrEqual(2000);
      // In force and proposed, never superseded or declined; the state column
      // says which, and a proposal is never called in force.
      // A withdrawn proposal keeps status 'pending' with its snapshot released
      // (the hub nulls the frozen terms), so a row with no child is not a plan.
      expect(query).toContain("WHERE status IN ('agreed','pending') AND child_id IS NOT NULL");
      expect(query).toContain("ELSE 'Proposed, not in force' END AS state");
      // "Agreed", not "in force": the effective window decides that, and the
      // schedule view prints it rather than asserting it.
      expect(query).toContain("WHEN 'agreed' THEN 'Agreed' ||");
      // Not range-filtered: it shows what is in force on the day it is printed.
      expect(query).not.toContain(":range_start");
      // Grouped by child, so the child leads the sort (the hub requires it);
      // proposals (no agreed_at) sort last within each child.
      expect(query).toMatch(/ORDER BY child_id, \(agreed_at IS NULL\), agreed_at/);
    }
  });

  // Photos on the journal: one append-only row per photo, naming the entry it
  // documents, readable by every adult in the space and deletable by nobody.
  describe("journal photos", () => {
    it("keeps each photo as an append-only row that names its entry", () => {
      const rec = manifest.append_only_records.journal_photos;
      expect(rec.table).toBe("journal_photos");
      expect(rec.parent_table).toBe("custody_log");
      expect(rec.parent_fk_column).toBe("entry_id");
      // A photo documents an account — an exchange, where the child was, a
      // note, or a dispute — never a bare acknowledgement or a check-in (a
      // time, which nothing draws photos beside); and only its own author's:
      // the hub refuses a photo on the other parent's testimony.
      expect(rec.parent_blocked_status_values).toEqual(["acknowledge", "exchange_checkin"]);
      expect(rec.parent_owner_column).toBe("created_by");
      expect(rec.required_columns).toEqual(["entry_id", "child_id", "photo_file_id"]);
      expect(rec.write_acl).toEqual({ require_role: "adult" });
      expect(manifest.row_policies.journal_photos).toEqual({ kind: "endpoint_only", read: "adult", audit_writes: true });
    });

    it("declares both file columns, and lets the photos (thumbnails with them) expire with their entry", () => {
      expect(manifest.file_columns.journal_photos).toEqual({ columns: ["photo_file_id", "thumb_file_id"] });
      // No clock of their own: a household that keeps the custody record longer
      // (ahead of a court date) keeps its photos exactly as long.
      expect(manifest.retention.journal_photos).toBeUndefined();
      expect(manifest.retention.custody_log.dependent_tables).toEqual([
        { table: "journal_photos", foreign_key: "entry_id", file_id_column: ["photo_file_id", "thumb_file_id"] },
      ]);
      const migration = readFileSync(join(__dirname, "../migrations/011_journal_photos.sql"), "utf-8");
      // The cascade selects and deletes by entry_id.
      expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS app_co_parenting__journal_photos_entry_idx\s+ON app_co_parenting__journal_photos \(entry_id, created_at\)/);
      expect(migration).not.toMatch(/CHECK\s*\(/);
    });

    it("opens the bytes to every adult in the space and to nobody else, and lets no one delete them", () => {
      // Children can read nothing of the journal; a supporting adult who can
      // read the entry can see its photo. The default would hand the bytes to
      // a child; uploader_only would hide them from the other parent.
      expect(manifest.file_acls).toEqual({ read: "adults", write: { require_role: "adult", steward_household_only: true } });
    });

    it("lists every photo in a report by file id, since a report carries no images", () => {
      const view = manifest.reports.views.find((v) => v.id === "journal_photos");
      expect(view.columns.map((c) => c.key)).toEqual(["day", "child", "entry_kind", "entry_id", "file_id", "added_by", "added_at"]);
      expect(view.source.query).toContain("LEFT JOIN app_co_parenting__custody_log l ON l.id = p.entry_id");
      // The entry may have expired before its photo: the photo row names the child too.
      expect(view.source.query).toContain("COALESCE(l.child_id, p.child_id) AS child");
      // Ranged on the DAY the entry is about, so a photo added later than the
      // day it documents lands in the same document as its entry.
      expect(view.source.query).toContain("COALESCE(l.day, substr(p.created_at, 1, 10)) >= :range_start");
      expect(manifest.reports.views.length).toBeLessThanOrEqual(12);
    });
  });

  // A check-in is the hub's time, not a parent's: its record takes no time
  // column at all, so the only time it carries is the created_at the hub
  // stamps. It is not answered — the other parent checks in too — and rows
  // written together for one exchange share an exchange_id.
  it("takes a check-in at an exchange with no time of its own", () => {
    const rec = manifest.append_only_records.custody_checkins;
    expect(rec).toMatchObject({
      table: "custody_log", writer_column: "created_by", created_at_column: "created_at",
      write_acl: { require_role: "adult" }, value_formats: { day: "date_not_future" },
    });
    expect(rec.allowed_values).toEqual({ kind: ["exchange_checkin"] });
    // Nothing but who, when (the hub's) and for which child: no words, no time.
    expect(rec.allowed_columns).toEqual(["child_id", "day", "kind", "exchange_id"]);
    expect(manifest.append_only_records.custody_answers.parent_blocked_status_values).toContain("exchange_checkin");
    for (const name of ["custody_log", "custody_checkins", "custody_answers"]) {
      expect(manifest.append_only_records[name].allowed_columns).toContain("exchange_id");
      expect(manifest.append_only_records[name].max_text_lengths.exchange_id).toBe(64);
    }
    // Plaintext by its `_id` suffix; listing it as well would only restate it.
    expect(manifest.db_plaintext_columns).not.toContain("exchange_id");
    expect(manifest.reports.views.find((v) => v.id === "exchange_log").description).toContain("exchange_checkin");
  });

  // A dated entry not tied to an exchange, through its own record over the
  // journal table: a note needs words, and the kind is fixed.
  it("takes a general journal note as testimony on the same journal", () => {
    const rec = manifest.append_only_records.custody_notes;
    expect(rec.table).toBe("custody_log");
    expect(rec.allowed_values).toEqual({ kind: ["note"] });
    expect(rec.required_columns).toEqual(["child_id", "day", "kind", "note"]);
    expect(rec.value_formats).toEqual({ day: "date_not_future" });
    // Closed to answers for now: the app draws answers under exchange rows
    // only, and an answer nobody can see is worse than none. Open it when the
    // Journal card renders them.
    expect(manifest.append_only_records.custody_answers.parent_blocked_status_values).toContain("note");
    // Notes print in the exchange log, which says so in its title.
    expect(manifest.reports.views.find((v) => v.id === "exchange_log").title).toBe("Exchange log and journal");
  });

  // The record a court is handed names each holiday in words, not as JSON.
  it("prints the holiday history one rule to a line", () => {
    const view = manifest.reports.views.find((v) => v.id === "holiday_schedule");
    expect(view.columns.map((c) => c.key)).toEqual([
      "agreed_at", "child", "holiday", "falls", "even_years", "odd_years", "exchange_time", "proposed_by", "rationale", "state",
    ]);
    expect(view.source.query).toContain("json_each(");
    expect(view.source.query).not.toContain("rules AS rules");
    // The hub writes each rule out in words; the query only hands it the rule.
    expect(view.columns.find((c) => c.key === "falls").format).toBe("recurring_rule");
  });

  // One definition of a proposal's terms, for the form and the draft alike.
  it("builds the form's proposal through scheduleProposalTerms and inherits no end date", () => {
    expect(entrypoint).toMatch(/const terms = scheduleProposalTerms\(form, spaceTimeZone\)/);
    expect(entrypoint).not.toMatch(/existing\?\.effective_to/);
  });
});

// ── ai_access SQL file validation ─────────────────────────────────────────────
// Auto-discovers all db_exports/db_mutations/db_inserts/db_deletes entries and
// validates each SQL file for type, household_id filter, and single-statement.

if (manifest.ai_access) {
  const ai = manifest.ai_access;

  const SQL_TYPES = [
    { field: "db_exports",   dir: "queries",   keyword: /^(SELECT|WITH)\b/i, label: "SELECT or WITH" },
    { field: "db_mutations", dir: "mutations",  keyword: /^UPDATE\b/i,        label: "UPDATE"         },
    { field: "db_inserts",   dir: "inserts",    keyword: /^INSERT\b/i,        label: "INSERT"         },
    { field: "db_deletes",   dir: "deletes",    keyword: /^DELETE\b/i,        label: "DELETE"         },
  ];

  for (const { field, dir, keyword, label } of SQL_TYPES) {
    const names = ai[field] ?? [];
    if (names.length === 0) continue;

    describe(`ai_access.${field}`, () => {
      it(`each name has a src/${dir}/{name}.sql file`, () => {
        for (const name of names) {
          const path = join(__dirname, `../src/${dir}/${name}.sql`);
          expect(existsSync(path), `missing: src/${dir}/${name}.sql`).toBe(true);
        }
      });

      it(`each SQL file starts with ${label}`, () => {
        for (const name of names) {
          const path = join(__dirname, `../src/${dir}/${name}.sql`);
          if (!existsSync(path)) continue;
          const sql = readFileSync(path, "utf-8").trim();
          expect(
            keyword.test(sql),
            `src/${dir}/${name}.sql must start with ${label}, got: ${sql.slice(0, 50)}`
          ).toBe(true);
        }
      });

      it(`each SQL file is a single statement (no semicolons)`, () => {
        for (const name of names) {
          const path = join(__dirname, `../src/${dir}/${name}.sql`);
          if (!existsSync(path)) continue;
          const sql = readFileSync(path, "utf-8");
          expect(
            sql.includes(";"),
            `src/${dir}/${name}.sql must not contain semicolons`
          ).toBe(false);
        }
      });
    });
  }

  if (ai.db_inserts?.length) {
    describe("ai_access.db_inserts schemas", () => {
      it("each insert has a src/schemas/{name}.json file", () => {
        for (const name of ai.db_inserts) {
          const path = join(__dirname, `../src/schemas/${name}.json`);
          expect(existsSync(path), `missing: src/schemas/${name}.json`).toBe(true);
        }
      });

      it("each schema file is valid JSON", () => {
        for (const name of ai.db_inserts) {
          const path = join(__dirname, `../src/schemas/${name}.json`);
          if (!existsSync(path)) continue;
          expect(
            () => JSON.parse(readFileSync(path, "utf-8")),
            `src/schemas/${name}.json must be valid JSON`
          ).not.toThrow();
        }
      });

      it("each schema declares type:array with an items definition", () => {
        for (const name of ai.db_inserts) {
          const path = join(__dirname, `../src/schemas/${name}.json`);
          if (!existsSync(path)) continue;
          let schema;
          try { schema = JSON.parse(readFileSync(path, "utf-8")); } catch { continue; }
          expect(schema.type, `src/schemas/${name}.json must declare "type": "array"`).toBe("array");
          expect(
            Array.isArray(schema.items) || (typeof schema.items === "object" && schema.items !== null),
            `src/schemas/${name}.json must declare "items" to validate params`
          ).toBe(true);
        }
      });

      it("schema maxItems matches the number of $N placeholders in the SQL", () => {
        for (const name of ai.db_inserts) {
          const sqlPath    = join(__dirname, `../src/inserts/${name}.sql`);
          const schemaPath = join(__dirname, `../src/schemas/${name}.json`);
          if (!existsSync(sqlPath) || !existsSync(schemaPath)) continue;
          const sql = readFileSync(sqlPath, "utf-8");
          let schema;
          try { schema = JSON.parse(readFileSync(schemaPath, "utf-8")); } catch { continue; }
          const paramNums = [...sql.matchAll(/\$(\d+)/g)].map(m => parseInt(m[1], 10));
          const maxParam  = paramNums.length > 0 ? Math.max(...paramNums) : 0;
          expect(
            schema.maxItems,
            `src/schemas/${name}.json maxItems (${schema.maxItems}) must equal SQL $N count (${maxParam})`
          ).toBe(maxParam);
        }
      });
    });
  }
}
