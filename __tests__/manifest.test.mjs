import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));

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

  it("declares no ai_access — booking rows hold outsiders' names and contact info", () => {
    // Deliberate (meal-train and event-rsvps precedent): the tables carry PII
    // of people outside the household, so they stay off AI surfaces.
    expect(manifest.ai_access).toBeUndefined();
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
}

// The Today agenda and the glance tile both read `slots`, the CHILD table.
// Every filter an occasion-level decision implies therefore has to be spelled
// out here — the row itself only knows about one slot. Without the JOIN,
// closing an occasion would leave its slots on Today and on the home tile,
// still advertising times for a sheet whose share links had already stopped
// working (the meal-train bug, inherited by construction).
describe("the Today and glance surfaces respect the parent occasion", () => {
  const surfaces = [
    ["agenda", manifest.agenda?.source?.query],
    ["glance", manifest.glance?.source?.query],
  ];

  for (const [name, query] of surfaces) {
    describe(name, () => {
      it("is a sql surface over the slots table", () => {
        expect(query, `manifest.${name}.source.query is missing`).toBeTruthy();
        expect(query).toContain("app_booking_slots__slots");
      });

      it("joins the parent occasion and requires it to be open", () => {
        expect(query).toContain("JOIN app_booking_slots__occasions");
        expect(query).toMatch(/ON o\.id = s\.occasion_id AND o\.status = 'open'/);
      });

      it("still filters out the slots the app itself closed", () => {
        // The occasion-level gate is additional to the per-slot one, never a
        // replacement: an open occasion can hold a slot an organizer shut.
        expect(query).toMatch(/s\.status (?:!=|=) 'open'|s\.status != 'closed'/);
      });

      it("compares the day token against a plaintext column", () => {
        // slot_date earns plaintext from its _date suffix. An encrypted column
        // here would never compare equal and the surface would go silently empty.
        expect(query).toContain("s.slot_date");
        expect(query).toContain(":today");
      });

      it("orders by a column declared plaintext — ciphertext orders meaninglessly", () => {
        expect(query).toContain("s.start_time");
        expect(manifest.db_plaintext_columns).toContain("start_time");
      });
    });
  }
});

// Fixes that live at call sites rather than in an exported function, pinned in
// the source because the UI harness cannot reach them (the deep link needs a
// query string the runner does not pass).
describe("index.html call sites", () => {
  const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

  it("applies ?occasionId on the first load only", () => {
    // handleDeepLink() must not run inside refresh(), or pressing Refresh
    // after backing out of a deep-linked occasion throws the organizer
    // straight back into it (the meal-train bug).
    // Awaited since the archive split: a ?occasionId pointing at a CLOSED
    // sheet now has to pull the closed set before it can select it.
    expect(html).toContain("if (deepLink) await handleDeepLink();");
    expect(html).toContain("refresh({ deepLink: true })");
    expect(html.match(/handleDeepLink\(\)/g)).toHaveLength(2); // the guarded call + the declaration
  });

  it("never turns a typed capacity into a bare Number(x) || fallback", () => {
    // That idiom reads a cleared input as the fallback silently. parseCapacity()
    // carries the leave-it-alone semantics instead.
    expect(html).not.toMatch(/Number\(\s*(?:raw|capacity)\s*\)\s*\|\|\s*[01]/);
    expect(html).toContain("parseCapacity(capacity, 1)");
    expect(html).toContain("parseCapacity(raw, current)");
  });

  it("paginates every initial table read below the Hub response ceiling", () => {
    expect(html).toContain("const DB_PAGE_SIZE = 1000");
    expect(html).toContain("async function dbAll(sql, params = [])");
    // Bookings are scoped to their parent sheet's status now, so the read is a
    // JOIN — but it must still go through dbAll (paged), never a bare dbq.
    expect(html).toContain('dbAll("SELECT b.* FROM app_booking_slots__bookings b JOIN');
    expect(html).not.toContain('dbq("SELECT * FROM app_booking_slots__bookings');
    expect(html).not.toContain('dbq("SELECT b.* FROM app_booking_slots__bookings');
  });

  it("rejects slot runs that cannot fit in one atomic batch", () => {
    expect(html).toContain("const ATOMIC_SLOT_LIMIT = 25");
    expect(html).toContain("times.length > ATOMIC_SLOT_LIMIT");
    expect(html).toContain("End time must be after the start time.");
  });
});
