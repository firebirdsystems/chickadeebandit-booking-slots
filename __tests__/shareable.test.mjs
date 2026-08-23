import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const appHtml = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const logicJs = readFileSync(join(__dirname, "../src/logic.js"), "utf-8");

const migrationsDir = join(__dirname, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

// Mirrors the hub's BUILTIN_APP_DB_PLAINTEXT_COLS + suffix rules
// (packages/hub/src/cloudflare/manifest-common.ts). A column the hub filters,
// orders, joins or compares on must be plaintext: ciphertext is AES-GCM with a
// random IV, so an equality against an encrypted column silently matches
// nothing and a numeric comparison is meaningless.
const BUILTIN_PLAINTEXT = new Set([
  "id", "household_id", "created_at", "updated_at", "sent_at", "read_at",
  "expires_at", "last_synced_at", "completed", "all_day",
  "status", "type", "category", "week", "emoji", "icon",
  "position", "sort_order", "pinned", "key", "version",
  "visibility", "audience",
  "membership_type", "membership_roles",
]);

function isPlaintext(column) {
  return (
    BUILTIN_PLAINTEXT.has(column) ||
    /_(id|at|date|by)$/.test(column) ||
    (manifest.db_plaintext_columns ?? []).includes(column)
  );
}

function columnsOf(table) {
  const body = schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS app_booking_slots__${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  expect(body, `no CREATE TABLE for ${table}`).toBeTruthy();
  const created = body[1]
    .split("\n")
    .map((line) => line.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/))
    .filter(Boolean)
    .map((m) => m[1]);
  // Later migrations add columns by ALTER; read those too, or this helper
  // reports a live column as missing (the trap volunteer hit).
  const altered = [...schema.matchAll(
    new RegExp(`ALTER TABLE app_booking_slots__${table} ADD COLUMN ([a-z_]+)\\b`, "g"),
  )].map((m) => m[1]);
  return [...created, ...altered];
}

const item = manifest.shareable.occasion;
const feed = item.feed;
const submit = item.submit;
const slotField = submit.fields.find((f) => f.column === "slot_id");

describe("shareable.occasion", () => {
  it("shares the occasion itself, and projects only columns it has", () => {
    expect(item.table).toBe("occasions");
    const columns = columnsOf("occasions");
    expect(columns).toContain(item.title_column);
    for (const col of item.columns) {
      expect(columns, `item projects unknown column ${col.column}`).toContain(col.column);
    }
  });

  it("closes every link on an occasion by closing the occasion", () => {
    // Share reads BYPASS row policies, so the only gate on the public page is
    // this one. It admits `open` alone: a closed occasion must stop both
    // showing and — because the submit path re-checks the same predicate —
    // collecting.
    expect(item.visible_where).toEqual({ column: "status", values: ["open"] });
    expect(isPlaintext("status")).toBe(true);
  });

  it("declares no owner_column, so an automation-opened occasion is still shareable", () => {
    // `owner_column` gates minting on created_by matching the caller. The
    // open_occasion automation writes created_by = "automation", which is no
    // member id — an owner gate would make exactly the occasions an automation
    // opens permanently unshareable. Adult is the gate instead.
    expect(item.owner_column).toBeUndefined();
    expect(manifest.automation_actions.open_occasion.steps[0].values.created_by).toBe("automation");
  });

  it("never publishes a member's name or id to the internet", () => {
    // The feed and every aggregate read `bookings`, which has no member column
    // at all — there is no member ledger in this app.
    const tables = [feed.table, ...(item.aggregates ?? []).map((a) => a.table)];
    expect(tables.every((t) => t === "bookings")).toBe(true);
    expect(columnsOf("bookings").some((c) => c === "member_id" || c === "created_by")).toBe(false);
  });
});

describe("shareable.occasion.feed", () => {
  it("reads the booking table the share form writes to", () => {
    expect(feed.table).toBe(submit.table);
    expect(feed.fk_column).toBe(submit.fk_column);
    expect(feed.fk_column).toBe("occasion_id");
  });

  it("is gated per occasion from the shared row itself", () => {
    // parent_where (memory-wall's device): names on a driveway-sale page are
    // normal, names on a conference page are not, so the who's-booked feed is
    // the organizer's call per sheet — and the schema default is 'no', because
    // the private default is the safe one.
    expect(feed.parent_where).toEqual({ column: "show_bookings", values: ["yes"] });
    expect(isPlaintext("show_bookings")).toBe(true);
    expect(schema).toMatch(/show_bookings\s+TEXT NOT NULL DEFAULT 'no'/);
    expect(appHtml).toContain('data-testid="share-show-bookings"');
  });

  it("projects only columns that exist on bookings", () => {
    const columns = columnsOf("bookings");
    for (const col of feed.columns) {
      expect(columns, `feed projects unknown column ${col.column}`).toContain(col.column);
    }
  });

  it("orders on a plaintext column that exists", () => {
    expect(columnsOf("bookings")).toContain(feed.order_column);
    expect(isPlaintext(feed.order_column), `${feed.order_column} must be plaintext to order on`).toBe(true);
  });

  it("never publishes a visitor's contact info or note", () => {
    // guest_contact is typed by one visitor FOR the organizer; the feed is
    // read by every other visitor. Same for the free-text note. The public
    // page gets the name and the timestamp, nothing else.
    const projected = feed.columns.map((c) => c.column);
    expect(projected).not.toContain("guest_contact");
    expect(projected).not.toContain("guest_note");
    expect(projected).toEqual(["guest_name", "created_at"]);
  });

  it("never publishes the raw slot id", () => {
    // A feed prints stored values and cannot join, so projecting slot_id would
    // show visitors a UUID. The `list` aggregate is what resolves those ids.
    expect(feed.columns.some((c) => c.column === "slot_id")).toBe(false);
  });

  it("keeps each public feed aligned with one link's submission limit", () => {
    expect(feed.max_items).toBe(submit.max_submissions);
  });
});

describe("shareable.occasion.aggregates", () => {
  const list = item.aggregates.find((a) => a.op === "list");

  it("resolves slot ids to human times through a lookup", () => {
    // Feeds cannot join; runAggregate's list op can. This is how the public
    // page says WHICH times are already taken — no names attached, so it is
    // safe even with show_bookings off.
    expect(list.table).toBe("bookings");
    expect(list.value_column).toBe("slot_id");
    expect(list.lookup).toEqual({ table: "slots", label_column: "label" });
    expect(isPlaintext(list.value_column), "the lookup JOINs on this column; ciphertext never joins").toBe(true);
    expect(columnsOf("slots")).toContain(list.lookup.label_column);
  });

  it("counts booking rows only", () => {
    const count = item.aggregates.find((a) => a.op === "count");
    expect(count.table).toBe("bookings");
    expect(count.fk_column).toBe("occasion_id");
  });
});

// The dynamic slot select: the hub resolves `slots` for the public form and
// folds a per-option capacity claim into the INSERT's own WHERE, so two
// visitors can never take the same last spot.
describe("shareable.occasion.submit.slot_id (values_from)", () => {
  it("is a select sourcing its choices from the slots table", () => {
    expect(slotField.type).toBe("select");
    expect(slotField.values, "values and values_from are mutually exclusive").toBeUndefined();
    expect(slotField.values_from.table).toBe("slots");
    expect(slotField.values_from.fk_column).toBe("occasion_id");
  });

  it("keys options on columns the slots table actually has", () => {
    const columns = columnsOf("slots");
    for (const key of ["fk_column", "id_column", "label_column", "capacity_column"]) {
      expect(columns, `slots has no ${slotField.values_from[key]}`).toContain(slotField.values_from[key]);
    }
  });

  it("labels each option with a human date and time, not raw stored values", () => {
    // The hub projects a stored column into that dropdown and cannot format a
    // date or a time, so the app writes `label` from slotLabel() — see the
    // pairing test below, which keeps it from drifting off the real columns.
    expect(slotField.values_from.label_column).toBe("label");
    expect(logicJs).toContain("export function slotLabel(");
  });

  it("writes the chosen option id into a real, plaintext column", () => {
    expect(columnsOf("bookings")).toContain("slot_id");
    expect(isPlaintext("slot_id"), "the hub writes the option id raw, outside the codec").toBe(true);
  });

  it("bounds bookings with ONE capacity column, because there is only one ledger", () => {
    // volunteer and potluck need a separate guest_capacity: their members
    // claim rows in a table the hub also counts, so one column would be spent
    // twice. meal-train's member claim closes the date. HERE there is no
    // member lane at all — every booking, whoever made it, goes through the
    // link into `bookings` — so `capacity` is the whole story and a second
    // column would have nothing to count.
    expect(slotField.values_from.capacity_column).toBe("capacity");
    expect(isPlaintext("capacity")).toBe(true);
    expect(columnsOf("slots")).not.toContain("guest_capacity");
    // No member-claim write anywhere in the app: the single-ledger claim is
    // structural, not a policy accident.
    expect(appHtml).not.toMatch(/covered_by|claimed_by|SET status = 'covered'/);
  });

  it("never allows a zero-capacity slot — closing is the only way to take one off the menu", () => {
    // meal-train's `capacity: 0` kept a night for the household while the link
    // was live: a second door this app does not have. With one ledger, zero
    // capacity would just be a confusing spelling of `closed`, so the CHECK
    // floors at 1 and parseCapacity mirrors it.
    expect(schema).toMatch(/capacity\s+INTEGER NOT NULL DEFAULT 1 CHECK \(capacity >= 1\)/);
    expect(logicJs).toContain("n >= 1 ? n : fallback");
  });

  it("offers only slots the app itself considers open", () => {
    expect(slotField.values_from.where).toEqual([{ column: "status", values: ["open"] }]);
    expect(isPlaintext("status")).toBe(true);
  });

  it("is required, so nobody can book while dodging the capacity bound", () => {
    // A booking naming no slot is meaningless to the organizer AND is a way
    // past `capacity` entirely. When every slot is taken the form fails
    // closed, which is correct here: the sheet is full. The share dialog
    // warns when that happens for the wrong reason (no slots laid out yet).
    expect(slotField.required).toBe(true);
    expect(appHtml).toContain('data-testid="share-no-slots"');
    expect(appHtml).toContain("openForForm(occasionId).length");
  });

  it("stays inside the hub's single-statement bind budget", () => {
    // id + fk, one per field, one per fixed value, parent admission (parent id
    // + visible_where values + owner + max_rows), and per dynamic select one
    // option id plus each of its filter values.
    const gate = item.visible_where?.values?.length ?? 0;
    const dynamic = submit.fields
      .filter((f) => f.values_from)
      .reduce((n, f) => n + 1 + (f.values_from.where ?? []).reduce((k, w) => k + w.values.length, 0), 0);
    const total = 2 + submit.fields.length
      + Object.keys(submit.fixed_values ?? {}).length
      + 1 + gate
      + (item.owner_column ? 1 : 0)
      + (manifest.row_policies.bookings.max_rows ? 1 : 0)
      + dynamic;
    expect(total).toBeLessThanOrEqual(80);
  });
});

describe("shareable.occasion.submit fields", () => {
  it("writes only plaintext columns — the submit path never runs the codec", () => {
    const columns = columnsOf("bookings");
    for (const field of submit.fields) {
      expect(columns, `bookings has no ${field.column}`).toContain(field.column);
      expect(isPlaintext(field.column), `${field.column} is written outside the codec`).toBe(true);
    }
    for (const column of Object.keys(submit.fixed_values ?? {})) {
      expect(isPlaintext(column)).toBe(true);
    }
  });

  it("requires a name, which is the whole point of a sign-up sheet", () => {
    const name = submit.fields.find((f) => f.column === "guest_name");
    expect(name.required).toBe(true);
  });

  it("asks for contact info but does not demand it", () => {
    // A teacher needs a way to reach the family whose plans changed; a
    // driveway-sale buyer legitimately declines. Optional is the only setting
    // that serves both.
    const contact = submit.fields.find((f) => f.column === "guest_contact");
    expect(contact.required).toBe(false);
  });

  it("lets the DB stamp created_at, because an external INSERT never sets it", () => {
    // The submit path writes id + fk + declared fields and nothing else, so any
    // other NOT NULL column needs a DB default. SQLite cannot add one by ALTER
    // later, which is why it is in 001.
    expect(schema).toMatch(/created_at\s+TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/);
    expect(logicJs).toContain("export function normalizeTimestamp(");
  });

  it("does not declare the submit event in publishes", () => {
    // Declaring it would let any household member forge a "somebody booked"
    // event through the events endpoint. memory-wall sets the precedent.
    expect(manifest.publishes).not.toContain(submit.event);
  });
});

// Booking rows are authored by anonymous visitors through a path that bypasses
// every member-side gate, so the table stays endpoint_only: the app may read
// the rows but may never edit or delete them. Widening it to adult_writable
// would hand every adult in a shared space edit rights over bookings on
// someone else's sheet — steward_writes_only is inert outside a roster, and
// booking-slots cannot be roster-installed anyway (its contexts carry no
// shared_space.roster token; the inward, member-authed version of this app is
// volunteer's slot_claims) — a worse trade than living without a delete
// affordance. The organizer clears a bogus booking by removing the slot.
describe("row_policies.bookings", () => {
  const policy = manifest.row_policies.bookings;

  it("stays write-closed to members", () => {
    expect(policy.kind).toBe("endpoint_only");
    expect(policy.read).toBe("everyone");
  });

  it("masks visitor contact details and notes from children", () => {
    expect(policy.column_read_acls).toEqual({
      guest_contact: { visible_to: ["adult"] },
      guest_note: { visible_to: ["adult"] },
    });
  });

  it("declares no member-facing write surface over external rows", () => {
    expect(policy.steward_writes_only).toBeUndefined();
    expect(policy.audit_writes).toBeUndefined();
  });

  it("is not roster-installable, which is why the read stays open", () => {
    expect(manifest.contexts).not.toContain("shared_space.roster");
  });

  it("does not turn the per-link submission limit into an app-wide lifetime cap", () => {
    expect(policy.max_rows).toBeUndefined();
  });
});

// endpoint_only children cannot be deleted by ANY app SQL, so without these
// declarations a deleted occasion would leave invisible, undeletable, billed
// rows behind — and removing a slot is the app's ONLY way to clear a bogus
// booking, so the slots→bookings cascade is a feature, not just hygiene.
describe("delete_cascades", () => {
  it("reclaims the booking rows a deleted occasion or slot leaves behind", () => {
    expect(manifest.delete_cascades.occasions).toEqual([
      { table: "bookings", foreign_key: "occasion_id" },
      { table: "slots", foreign_key: "occasion_id" },
    ]);
    expect(manifest.delete_cascades.slots).toEqual([
      { table: "bookings", foreign_key: "slot_id" },
    ]);
  });

  it("names bookings BEFORE slots, so the grandchildren go first", () => {
    const [first] = manifest.delete_cascades.occasions;
    expect(first.table).toBe("bookings");
  });

  it("tells the organizer what a removal destroys before it happens", () => {
    // The cascade is silent by design; a real person's booking vanishing must
    // not be.
    expect(appHtml).toContain("every booking on it at deletion time");
    expect(appHtml).toContain("await refreshSlotBookings(slotId)");
    expect(appHtml).toContain("await refreshOccasionBookings(occasionId)");
    expect(appHtml).toContain("SET status = 'closed' WHERE id = ?");
  });

  it("sends each declared delete as ONE statement, never a batch", () => {
    // The /api/db batch form refuses a delete_cascades table rather than
    // silently skipping the reclaim.
    expect(appHtml).toContain("DELETE FROM app_booking_slots__occasions WHERE id = ?");
    expect(appHtml).toContain("DELETE FROM app_booking_slots__slots WHERE id = ?");
  });
});

// Two columns on `slots` mirror data that lives elsewhere, because the
// surfaces that read them (a share-form dropdown, the agenda/glance
// projections) cannot format a date/time or re-derive the parent title.
// Denormalization is only safe while every writer maintains it.
describe("the denormalized columns stay in step", () => {
  it("builds a slot row in exactly one place", () => {
    expect(appHtml).toContain("function newSlotRow(occasion, slotDate, start, end, capacity = 1)");
    expect(appHtml).toContain("label: slotLabel(slotDate, start, end)");
    expect(appHtml).toContain("occasion_title: occasion.title");
    // Only that one helper feeds the only INSERT.
    const inserts = appHtml.match(/INSERT INTO app_booking_slots__slots/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  it("re-stamps occasion_title on every slot when the occasion is renamed", () => {
    // Otherwise Today and the home-strip tile would keep naming an occasion
    // under a title it no longer has.
    expect(appHtml).toContain("UPDATE app_booking_slots__slots SET occasion_title = ? WHERE occasion_id = ?");
    const updateFn = appHtml.slice(appHtml.indexOf("async function updateOccasion("));
    expect(updateFn.slice(0, updateFn.indexOf("\n}\n"))).toContain("SET occasion_title = ?");
    expect(updateFn.slice(0, updateFn.indexOf("\n}\n"))).toContain("await dbBatch([");
  });

  it("inserts a generated slot run through one atomic batch", () => {
    const addFn = appHtml.slice(appHtml.indexOf("async function addSlots("));
    expect(addFn.slice(0, addFn.indexOf("\n}\n"))).toContain("await dbBatch(rows.map(insertSlotStatement))");
  });

  it("reads those columns from the surfaces that cannot re-derive them", () => {
    expect(manifest.agenda.source.query).toContain("occasion_title AS title");
    expect(manifest.glance.source.query).toContain("occasion_title AS title");
    expect(manifest.agenda.source.query).toContain("slot_date = :today");
    expect(isPlaintext("slot_date"), "a day token can only compare a plaintext column").toBe(true);
  });

  it("preserves each slot's start time on the Today surface", () => {
    expect(manifest.agenda.source.query).toContain("s.slot_date || 'T' || s.start_time");
  });
});

describe("the app's own controls over the share surface", () => {
  it("never writes the bookings table", () => {
    expect(appHtml).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) app_booking_slots__bookings/);
    expect(appHtml).toContain("SELECT * FROM app_booking_slots__bookings");
  });

  it("describes read-only and writable share links truthfully", () => {
    expect(appHtml).toContain("Turn on booking below");
    expect(appHtml).toContain("This link is read-only");
    expect(appHtml).not.toContain("can see the sheet and book an open time");
  });

  it("writes capacity and status on slots, the controls it does own", () => {
    expect(appHtml).toContain("UPDATE app_booking_slots__slots SET capacity = ? WHERE id = ?");
    expect(appHtml).toContain("UPDATE app_booking_slots__slots SET status = ? WHERE id = ?");
    expect(appHtml).toContain("Capacity cannot be lower than that");
    expect(appHtml).toContain("SELECT COUNT(*) FROM app_booking_slots__bookings WHERE slot_id = ?");
  });

  it("does not advertise an empty new sheet as ready to book", () => {
    expect(appHtml).not.toContain("sendHubNotification");
    expect(appHtml).not.toContain("— pick a time.");
  });

  it("reports share-list failures instead of leaving an unhandled rejection", () => {
    expect(appHtml).toContain("Couldn't load share links");
    expect(appHtml).toMatch(/try \{\s*status = await share\.status\(\);/);
  });

  it("writes the feed gate on the occasion row the feed's parent_where reads", () => {
    expect(appHtml).toContain("UPDATE app_booking_slots__occasions SET show_bookings = ? WHERE id = ?");
  });

  it("gates every share control on the hub having injected the URLs", () => {
    expect(appHtml).toContain("createShareHelper(window.__SHARE_CREATE_URL");
    expect(appHtml).toContain("share.enabled && canManage()");
  });

  it("mints links against the declared item type", () => {
    expect(appHtml).toContain('share.create("occasion"');
    expect(Object.keys(manifest.shareable)).toEqual(["occasion"]);
  });

  it("hides Share on a closed occasion, where the link would be dead on arrival", () => {
    expect(appHtml).toContain("share.enabled && canManage() && !closed");
  });
});

describe("automation_actions.open_occasion", () => {
  const step = manifest.automation_actions.open_occasion.steps[0];

  it("writes only columns the occasions table has", () => {
    const columns = columnsOf("occasions");
    for (const column of Object.keys(step.values)) {
      expect(columns, `occasions has no ${column}`).toContain(column);
    }
  });

  it("supplies every NOT NULL column that has no default", () => {
    const body = schema.match(/CREATE TABLE IF NOT EXISTS app_booking_slots__occasions \(([\s\S]*?)\n\);/)[1];
    const required = body.split("\n")
      .map((l) => l.trim())
      .filter((l) => /NOT NULL/.test(l) && !/DEFAULT/.test(l))
      .map((l) => l.match(/^([a-z_]+)\b/)[1]);
    for (const column of required) {
      expect(Object.keys(step.values), `open_occasion omits NOT NULL column ${column}`).toContain(column);
    }
  });

  it("sets the semantically-load-bearing defaults explicitly, not by omission", () => {
    // The volunteer P2 lesson: a column with a DB default is invisible to the
    // NOT-NULL check above, and a semantically-wrong default ships silently.
    // The two such columns here are pinned to the values the app means.
    expect(step.values.show_bookings).toBe("no");
    expect(step.values.status).toBe("open");
  });

  it("dedupes on a plaintext column, so a retry cannot open a second occasion", () => {
    const dedupe = manifest.automation_actions.open_occasion.dedupe;
    expect(dedupe).toEqual({ table: "occasions", column: "source_event_id" });
    expect(columnsOf("occasions")).toContain("source_event_id");
    expect(isPlaintext("source_event_id")).toBe(true);
    expect(step.values.source_event_id).toBe("$event_id");
  });

  it("opens no slots, and says so", () => {
    // Which time slots to offer is a human decision — a run an automation
    // guessed would be wrong in both directions. An automation-opened occasion
    // is therefore shareable but empty, which is exactly what the share
    // dialog's no-slots warning is for.
    expect(step.table).toBe("occasions");
    expect(manifest.automation_actions.open_occasion.steps).toHaveLength(1);
    expect(manifest.automation_actions.open_occasion.description).toMatch(/lays out the slots/);
  });
});
