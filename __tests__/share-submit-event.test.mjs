import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

/**
 * The share link's guest form, and the hub event each guest submission fires.
 * The hub publishes the event (an app can never POST it) and decides its
 * payload from the event catalog; what this app owns is which table the form
 * writes, whether members are alerted, and the row policy that bounds what the
 * event may say.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));

const migrationsDir = join(__dirname, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

function columnsOf(table) {
  const body = schema.match(
    new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?app_[a-z0-9_]+__${table}\\s*\\(([\\s\\S]*?)\\n\\);`),
  );
  expect(body, `no CREATE TABLE for ${table}`).toBeTruthy();
  const created = body[1]
    .split("\n")
    .map((line) => line.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/i))
    .filter(Boolean)
    .map((m) => m[1]);
  const altered = [...schema.matchAll(
    new RegExp(`ALTER TABLE app_[a-z0-9_]+__${table} ADD COLUMN ([a-z_]+)\\b`, "g"),
  )].map((m) => m[1]);
  return [...created, ...altered];
}

const items = Object.entries(manifest.shareable ?? {}).filter(([, item]) => item.submit);
const [itemType, item] = items[0] ?? [];
const submit = item?.submit;

// A stranger just took a slot the household is counting on.
const ALERTS_MEMBERS = true;

describe("share-link guest submissions", () => {
  it("has exactly one writable share item", () => {
    expect(items.map(([t]) => t)).toEqual([itemType]);
  });

  it("fires a namespaced hub event", () => {
    expect(submit.event).toMatch(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/);
  });

  it(ALERTS_MEMBERS ? "alerts members on every guest submission" : "does not alert members per guest submission", () => {
    expect((manifest.alert_on ?? []).includes(submit.event)).toBe(ALERTS_MEMBERS);
  });

  it("never lists the event in publishes, which would let a member forge one", () => {
    expect(manifest.publishes ?? []).not.toContain(submit.event);
  });

  it("writes only columns the target table has", () => {
    const columns = columnsOf(submit.table);
    for (const column of [submit.fk_column, ...submit.fields.map((f) => f.column), ...Object.keys(submit.fixed_values ?? {})]) {
      expect(columns, `${submit.table}.${column}`).toContain(column);
    }
  });
});
