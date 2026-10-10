import { readFileSync, existsSync } from "fs";
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
    expect(logicImport).toMatch(/\bpartitionMessagesBySession\b/);
  });
});

// ── Numbers and statements the app and the manifest must agree on ─────────────
// The app cannot read its own manifest at runtime, so each of these lives in
// two places by necessity. Pinned here so they cannot drift apart silently.
describe("manifest ↔ app agreement", async () => {
  const { SWAP_HORIZON_DAYS, CUSTODY_LOOKBACK_DAYS, SCHEDULE_SNAPSHOT_COLUMNS } = await import("../src/logic.js");

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
    expect(stamped.sort()).toEqual(["message_log", "standing_schedule", "swap_requests"]);
    for (const id of stamped) {
      const query = manifest.reports.views.find((v) => v.id === id).source.query;
      expect(query, id).toMatch(/substr\([\w.]+_at, 1, 10\) <= substr\(:range_end, 1, 10\)/);
      expect(query, id).not.toMatch(/_at <= :range_end/);
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
