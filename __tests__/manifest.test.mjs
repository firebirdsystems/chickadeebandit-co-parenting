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
