import { describe, it, expect } from "vitest";
import {
  canManage, dateLabel, timeToMinutes, formatTime, timeLabel, slotLabel, slotTimes,
  normalizeTimestamp, parseCapacity,
  bookingsForSlot, bookingCount, isSlotFull, slotState,
  slotsForOccasion, openSlotsForForm, occasionTotals, searchableFields,
  buildCalendarEvents, CALENDAR_EXPORT_MAX_EVENTS,
  readInChunks, chunkIds, compareBookings, DB_MAX_IN_PARAMS,
} from "../src/logic.js";

const adult = { id: "a1", name: "Alex", role: "adult" };
const child = { id: "c1", name: "Casey", role: "child" };

const slot = (over = {}) => ({
  id: "s1", occasion_id: "o1", slot_date: "2026-03-03", start_time: "14:00", end_time: "14:15",
  label: "Tue, Mar 3 · 2:00–2:15 PM", occasion_title: "Conferences",
  capacity: 1, status: "open", created_at: "2026-03-01T00:00:00Z",
  ...over,
});
const booking = (over = {}) => ({
  id: "b1", occasion_id: "o1", slot_id: "s1", guest_name: "Marta",
  guest_contact: "555-0114", guest_note: "", created_at: "2026-03-01 17:04:00", ...over,
});

describe("canManage", () => {
  it("mirrors the adult_writable policy on occasions and slots", () => {
    expect(canManage(adult)).toBe(true);
    expect(canManage(child)).toBe(false);
    expect(canManage(null)).toBe(false);
  });
});

describe("dateLabel", () => {
  it("formats the human date half of a slot label", () => {
    expect(dateLabel("2026-03-03")).toBe("Tue, Mar 3");
    expect(dateLabel("2026-12-25")).toBe("Fri, Dec 25");
  });

  it("does not shift the weekday with the device timezone", () => {
    // The input is a bare yyyy-mm-dd with no zone. Reading it through LOCAL
    // getters names the previous day west of UTC — the same class of bug as
    // `date('now')` in an agenda query. `naive` is the implementation this one
    // is not: if the timezone swap below ever stops taking effect, the control
    // assertion fails rather than letting the real one pass vacuously.
    const naive = (iso) => new Date(iso).getDate();
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Midway";       // UTC-11
      expect(naive("2026-03-03"), "timezone swap had no effect — this test proves nothing").toBe(2);
      expect(dateLabel("2026-03-03")).toBe("Tue, Mar 3");
      process.env.TZ = "Pacific/Kiritimati";   // UTC+14
      expect(dateLabel("2026-03-03")).toBe("Tue, Mar 3");
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });

  it("passes anything that is not a plain date through untouched", () => {
    expect(dateLabel("")).toBe("");
    expect(dateLabel(null)).toBe("");
  });
});

describe("time formatting", () => {
  it("reads HH:MM as minutes and rejects everything else", () => {
    expect(timeToMinutes("14:15")).toBe(855);
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("24:00")).toBe(null);
    expect(timeToMinutes("2:15")).toBe(null);
    expect(timeToMinutes("")).toBe(null);
    expect(timeToMinutes(null)).toBe(null);
  });

  it("formats the stored wall-clock time as people read it, never through Date", () => {
    // The times are household-local floating values; parsing them through Date
    // would attach the device zone.
    expect(formatTime("14:15")).toBe("2:15 PM");
    expect(formatTime("00:05")).toBe("12:05 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatTime("09:30")).toBe("9:30 AM");
  });

  it("collapses a shared meridiem in a range and keeps a crossing one", () => {
    expect(timeLabel("14:00", "14:15")).toBe("2:00–2:15 PM");
    expect(timeLabel("11:30", "12:15")).toBe("11:30 AM–12:15 PM");
    expect(timeLabel("14:00", "")).toBe("2:00 PM");
    expect(timeLabel("", "")).toBe("");
  });

  it("builds the one label the public dropdown, agenda and glance all read", () => {
    expect(slotLabel("2026-03-03", "14:00", "14:15")).toBe("Tue, Mar 3 · 2:00–2:15 PM");
    expect(slotLabel("2026-03-03", "", "")).toBe("Tue, Mar 3");
  });
});

describe("slotTimes", () => {
  it("splits a window into a run of slots — the conference afternoon", () => {
    expect(slotTimes("14:00", "14:45", 15)).toEqual([
      { start: "14:00", end: "14:15" },
      { start: "14:15", end: "14:30" },
      { start: "14:30", end: "14:45" },
    ]);
  });

  it("drops a trailing partial slot rather than overrunning the window", () => {
    expect(slotTimes("14:00", "14:40", 15)).toEqual([
      { start: "14:00", end: "14:15" },
      { start: "14:15", end: "14:30" },
    ]);
  });

  it("treats no interval — or no end — as ONE slot, which is how a single slot is added", () => {
    expect(slotTimes("14:00", "15:00", "")).toEqual([{ start: "14:00", end: "15:00" }]);
    expect(slotTimes("14:00", "", 15)).toEqual([{ start: "14:00", end: "" }]);
  });

  it("rejects an end time that is not after the start", () => {
    expect(slotTimes("14:00", "13:00", 15)).toEqual([]);
    expect(slotTimes("14:00", "14:00", 15)).toEqual([]);
  });

  it("is bounded, so a typo'd interval cannot try to open hundreds of rows", () => {
    // The UI rejects anything above its 25-statement atomic batch ceiling;
    // this larger pure-logic ceiling lets it detect that the request overflowed.
    expect(slotTimes("00:00", "23:59", 1)).toHaveLength(96);
  });

  it("returns nothing without a valid start", () => {
    expect(slotTimes("", "15:00", 15)).toEqual([]);
    expect(slotTimes("nonsense", "15:00", 15)).toEqual([]);
  });
});

describe("normalizeTimestamp", () => {
  it("reads SQLite's datetime('now') as the UTC it actually is", () => {
    // bookings.created_at comes from a DB default, not from the app, and its
    // space-separated form is parsed as LOCAL time by JS.
    expect(normalizeTimestamp("2026-03-01 17:04:00")).toBe("2026-03-01T17:04:00Z");
  });

  it("leaves an ISO stamp and non-strings alone", () => {
    expect(normalizeTimestamp("2026-03-01T17:04:00Z")).toBe("2026-03-01T17:04:00Z");
    expect(normalizeTimestamp(null)).toBe(null);
  });
});

describe("parseCapacity", () => {
  it("reads a typed capacity, floored", () => {
    expect(parseCapacity("3")).toBe(3);
    expect(parseCapacity("2.7")).toBe(2);
  });

  it("treats a cleared field as 'leave it alone', never as a default", () => {
    // `Number("") || 1` is 1, which would silently resize a capacity-4 slot
    // the moment somebody cleared the box. A resize has to be typed.
    expect(parseCapacity("", 4)).toBe(4);
    expect(parseCapacity(undefined, 1)).toBe(1);
    expect(parseCapacity(null, 4)).toBe(4);
  });

  it("floors at ONE — the meal-train divergence", () => {
    // meal-train's capacity: 0 kept a night for the household while the link
    // was live: a second door this single-ledger app does not have. Here a
    // slot that should take nobody is `closed` (and CHECK (capacity >= 1)
    // backs it up), so zero is refused like any other nonsense.
    expect(parseCapacity("0", 2)).toBe(2);
    expect(parseCapacity("-1", 1)).toBe(1);
    expect(parseCapacity("lots", 2)).toBe(2);
    expect(parseCapacity(NaN, 2)).toBe(2);
  });
});

describe("the one ledger", () => {
  it("counts only bookings naming that slot", () => {
    const rows = [booking(), booking({ id: "b2", slot_id: "s2" })];
    expect(bookingsForSlot(rows, "s1")).toHaveLength(1);
    expect(bookingCount(rows, "s2")).toBe(1);
  });

  it("matches no slot for an empty slot id", () => {
    expect(bookingsForSlot([booking({ slot_id: "" })], "")).toEqual([]);
  });

  it("fills a slot at capacity, mirroring the hub's own claim predicate", () => {
    expect(isSlotFull(slot({ capacity: 1 }), [booking()])).toBe(true);
    expect(isSlotFull(slot({ capacity: 2 }), [booking()])).toBe(false);
    expect(isSlotFull(slot({ capacity: 2 }), [booking(), booking({ id: "b2" })])).toBe(true);
  });
});

describe("slotState", () => {
  it("distinguishes the three states a slot can be in", () => {
    expect(slotState(slot(), [])).toBe("open");
    expect(slotState(slot({ capacity: 1 }), [booking()])).toBe("full");
    expect(slotState(slot({ status: "closed" }), [])).toBe("closed");
  });

  it("keeps a closed slot closed even when its bookings are gone", () => {
    expect(slotState(slot({ status: "closed" }), [booking()])).toBe("closed");
  });
});

describe("openSlotsForForm", () => {
  const slots = [
    slot({ id: "s1", start_time: "14:00" }),
    slot({ id: "s2", start_time: "14:15", status: "closed" }),
    slot({ id: "s3", start_time: "14:30", capacity: 1 }),
    slot({ id: "s4", start_time: "14:45", occasion_id: "other" }),
  ];
  const taken = [booking({ slot_id: "s3" })];

  it("offers exactly what the manifest's values_from filter would", () => {
    // status = 'open' (the declared where) minus the ones the hub's capacity
    // claim would refuse.
    expect(openSlotsForForm(slots, taken, "o1").map(s => s.id)).toEqual(["s1"]);
  });

  it("drops a slot once bookings fill it", () => {
    expect(openSlotsForForm([slot({ id: "s1", capacity: 1 })], [booking()], "o1")).toEqual([]);
  });

  it("is what the share dialog warns on: an empty list means the form is dead", () => {
    // The slot select is `required`, so with no pickable option the public
    // form fails closed and the link collects nothing.
    expect(openSlotsForForm(slots, [], "nobody-home")).toEqual([]);
  });

  it("keeps slots in date-then-time order", () => {
    const shuffled = [
      slot({ id: "late", slot_date: "2026-03-04", start_time: "09:00" }),
      slot({ id: "second", slot_date: "2026-03-03", start_time: "15:00" }),
      slot({ id: "first", slot_date: "2026-03-03", start_time: "09:00" }),
    ];
    expect(slotsForOccasion(shuffled, "o1").map(s => s.id)).toEqual(["first", "second", "late"]);
  });
});

describe("occasionTotals", () => {
  const slots = [
    slot({ id: "s1" }),
    slot({ id: "s2", start_time: "14:15" }),
    slot({ id: "s3", start_time: "14:30", status: "closed" }),
  ];

  it("counts occupied spots toward one progress number and leaves closed ones out", () => {
    const t = occasionTotals("o1", slots, [booking({ slot_id: "s1" })]);
    expect(t).toMatchObject({ booked: 1, total: 2, pct: 50, complete: false });
  });

  it("reads complete only when every offered spot is spoken for", () => {
    const t = occasionTotals("o1", slots, [booking({ slot_id: "s1" }), booking({ id: "b2", slot_id: "s2" })]);
    expect(t).toMatchObject({ booked: 2, total: 2, pct: 100, complete: true });
  });

  it("never reads complete with nothing on offer", () => {
    expect(occasionTotals("o1", [slot({ id: "s3", status: "closed" })], []))
      .toMatchObject({ booked: 0, total: 0, complete: false });
  });

  it("counts a partly-booked multi-spot slot by occupied capacity", () => {
    expect(occasionTotals("o1", [slot({ id: "s1", capacity: 3 })], [booking()]))
      .toMatchObject({ booked: 1, total: 3, pct: 33, complete: false });
  });
});

describe("searchableFields", () => {
  it("finds a sheet by where it happens, not just its title", () => {
    const fields = searchableFields({ title: "Conferences", location: "Room 12", description: "Fifteen minutes each" });
    expect(fields).toContain("Room 12");
    expect(fields).toContain("Fifteen minutes each");
  });
});

describe("buildCalendarEvents", () => {
  const TODAY = "2026-03-03";
  const occasions = [
    { id: "o1", title: "Parent-teacher conferences", location: "Room 12",
      description: "Fifteen minutes each. Please arrive early.", status: "open" },
    { id: "o2", title: "Last spring's tryouts", location: "Gym", status: "closed" },
  ];
  const build = (slots, bookings, occ = occasions) => buildCalendarEvents(occ, slots, bookings, TODAY);

  it("emits a timed entry the hub can parse for a slot somebody booked", () => {
    const [ev] = build([slot({ slot_date: "2026-03-04" })], [booking()]);
    expect(ev.id).toBe("s1");
    expect(ev.title).toBe("Conferences");
    expect(ev.description).toBe("Marta");
    expect(ev.location).toBe("Room 12");
    expect(ev.start).toBe("2026-03-04T14:00");
    expect(ev.end).toBe("2026-03-04T14:15");
    expect(ev.all_day).toBe(false);
    // Guests book through the public link, so there is no member to attribute.
    expect(ev.member_ids).toEqual([]);
    expect(ev.source_label).toBe("Booking Slots");
  });

  it("exports nothing for a slot nobody has booked", () => {
    // An empty 15-minute slot is not an appointment. A laid-out conference
    // afternoon would otherwise spend the 100-entry cap on nothings.
    expect(build([slot({ slot_date: "2026-03-04" })], [])).toEqual([]);
  });

  it("names every guest on a multi-spot slot in one entry", () => {
    const [ev] = build(
      [slot({ slot_date: "2026-03-04", capacity: 2 })],
      [booking(), booking({ id: "b2", guest_name: "Dev Patel" })],
    );
    expect(ev.description).toBe("Marta, Dev Patel");
  });

  it("degrades a time-less slot to an all-day entry with no T in start", () => {
    const [ev] = build(
      [slot({ slot_date: "2026-03-04", start_time: "", end_time: "" })],
      [booking()],
    );
    expect(ev.start).toBe("2026-03-04");
    expect(ev.end).toBe("2026-03-04");
    expect(ev.all_day).toBe(true);
  });

  it("falls back to the start when a slot carries no end time", () => {
    const [ev] = build([slot({ slot_date: "2026-03-04", end_time: "" })], [booking()]);
    expect(ev.end).toBe("2026-03-04T14:00");
  });

  it("drops past slots and anything beyond the horizon", () => {
    const ids = build([
      slot({ id: "past", slot_date: "2026-03-02" }),
      slot({ id: "today", slot_date: TODAY }),
      slot({ id: "far", slot_date: "2027-03-04" }),
    ], [
      booking({ id: "bp", slot_id: "past" }),
      booking({ id: "bt", slot_id: "today" }),
      booking({ id: "bf", slot_id: "far" }),
    ]).map(e => e.id);
    expect(ids).toEqual(["today"]);
  });

  it("keeps the last day inside the horizon and drops the first day past it", () => {
    const ids = build([
      slot({ id: "edge", slot_date: "2026-08-30" }),   // TODAY + 180
      slot({ id: "over", slot_date: "2026-08-31" }),   // TODAY + 181
    ], [
      booking({ id: "be", slot_id: "edge" }),
      booking({ id: "bo", slot_id: "over" }),
    ]).map(e => e.id);
    expect(ids).toEqual(["edge"]);
  });

  it("skips a closed slot and a slot whose sheet is closed or gone", () => {
    expect(build([
      slot({ id: "shut", slot_date: "2026-03-04", status: "closed" }),
      slot({ id: "archived", occasion_id: "o2", slot_date: "2026-03-04" }),
      slot({ id: "orphan", occasion_id: "gone", slot_date: "2026-03-04" }),
    ], [
      booking({ id: "b1", slot_id: "shut" }),
      booking({ id: "b2", slot_id: "archived" }),
      booking({ id: "b3", slot_id: "orphan" }),
    ])).toEqual([]);
  });

  it("never exports a guest's contact details, note, or the sheet's description", () => {
    // guest_contact and guest_note carry column_read_acls restricting them to
    // adults, so they are NOT scope-wide readable — and this blob is scope-wide
    // and reaches external calendar services through the household ICS feed.
    // The sheet's description is free text a member typed, withheld for the
    // same reason. Asserted on the serialized payload, not on the fields we
    // happened to name, so a stray spread cannot smuggle one through.
    const json = JSON.stringify(build(
      [slot({ slot_date: "2026-03-04" })],
      [booking({ guest_contact: "555-0114", guest_note: "Running late from work" })],
    ));
    expect(json).toContain("Marta");
    expect(json).not.toContain("555-0114");
    expect(json).not.toContain("Running late from work");
    expect(json).not.toContain("Fifteen minutes each");
  });

  it("caps the payload at the hub's per-app ceiling, keeping the nearest slots", () => {
    // The hub's MAX_FEED_EVENTS_PER_APP and MAX_CROSS_APP_EVENTS_PER_APP are
    // both 100, so anything past that only burns bytes.
    const slots = [];
    const bookings = [];
    const day = (n) => new Date(Date.UTC(2026, 2, 4) + n * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < CALENDAR_EXPORT_MAX_EVENTS + 20; i++) {
      slots.push(slot({ id: `s${i}`, slot_date: day(i) }));
      bookings.push(booking({ id: `b${i}`, slot_id: `s${i}` }));
    }
    const events = build(slots, bookings);
    expect(events).toHaveLength(CALENDAR_EXPORT_MAX_EVENTS);
    expect(events[0].start).toBe("2026-03-04T14:00");
    expect(events.at(-1).id).toBe(`s${CALENDAR_EXPORT_MAX_EVENTS - 1}`);
  });
});


describe("reading bookings for more sheets than D1 will take parameters for", () => {
  // The whole point of this block is the count. Every other test here runs on
  // a handful of rows, and the failure being guarded against appears only past
  // 100 — which is also why it cannot be caught by asserting on the SQL string
  // in index.html, where the id list is built at runtime from whatever the
  // household happens to have.
  const ids = (n) => Array.from({ length: n }, (_, i) => `oc-${String(i).padStart(4, "0")}`);

  /** A stand-in for dbAll that records what each chunk was asked for. */
  function fakeDb(rowsById = () => []) {
    const calls = [];
    return {
      calls,
      run: async (chunk) => {
        calls.push(chunk);
        return chunk.flatMap(rowsById);
      },
    };
  }

  it("never asks for more parameters than D1 accepts", () => {
    expect(DB_MAX_IN_PARAMS).toBeLessThanOrEqual(100);
    for (const n of [0, 1, 89, 90, 91, 100, 101, 250, 1000]) {
      for (const part of chunkIds(ids(n))) {
        expect(part.length, `${n} sheets`).toBeLessThanOrEqual(DB_MAX_IN_PARAMS);
        expect(part.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers every sheet exactly once, in order, however many there are", () => {
    for (const n of [1, 90, 91, 180, 181, 250]) {
      const flat = chunkIds(ids(n)).flat();
      expect(flat, `${n} sheets`).toEqual(ids(n));
      expect(new Set(flat).size).toBe(n);
    }
  });

  it("reads 101 sheets as two statements rather than one oversized one", async () => {
    const db = fakeDb();
    await readInChunks(ids(101), db.run);
    expect(db.calls).toHaveLength(2);
    expect(db.calls.map(c => c.length)).toEqual([90, 11]);
  });

  it("sends nothing at all when there are no sheets", async () => {
    const db = fakeDb();
    expect(await readInChunks([], db.run)).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("restores one global order across the chunk boundary", async () => {
    // The bug a naive merge leaves behind: each chunk is ordered within itself,
    // so concatenating them sorts by CHUNK first. Sheet 100's booking is older
    // than sheet 1's here, and has to come first in the merged list.
    const rows = {
      "oc-0000": { id: "b-late", occasion_id: "oc-0000", created_at: "2026-03-09T10:00:00Z" },
      "oc-0100": { id: "b-early", occasion_id: "oc-0100", created_at: "2026-03-01T10:00:00Z" },
    };
    const db = fakeDb((id) => (rows[id] ? [rows[id]] : []));
    const merged = await readInChunks(ids(101), db.run);
    expect(merged.map(r => r.id)).toEqual(["b-early", "b-late"]);
  });

  it("breaks a tie on id, the way the SQL does", () => {
    const at = "2026-03-01T10:00:00Z";
    const sorted = [
      { id: "b-2", created_at: at },
      { id: "b-1", created_at: at },
    ].sort(compareBookings);
    expect(sorted.map(r => r.id)).toEqual(["b-1", "b-2"]);
    // Binary collation, not locale: uppercase sorts before lowercase, which is
    // what a single-chunk read would have returned.
    expect([{ id: "b", created_at: at }, { id: "B", created_at: at }].sort(compareBookings).map(r => r.id))
      .toEqual(["B", "b"]);
    expect(compareBookings({ id: "x", created_at: at }, { id: "x", created_at: at })).toBe(0);
  });

  it("treats a missing created_at as the earliest rather than throwing", () => {
    const sorted = [{ id: "b-2", created_at: "2026-03-01T10:00:00Z" }, { id: "b-1" }].sort(compareBookings);
    expect(sorted.map(r => r.id)).toEqual(["b-1", "b-2"]);
  });

  it("refuses a chunk size that would loop forever", () => {
    expect(() => chunkIds(ids(3), 0)).toThrow();
  });
});
