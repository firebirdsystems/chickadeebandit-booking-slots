import { describe, it, expect } from "vitest";
import {
  canManage, dateLabel, timeToMinutes, formatTime, timeLabel, slotLabel, slotTimes,
  normalizeTimestamp, parseCapacity,
  bookingsForSlot, bookingCount, isSlotFull, slotState,
  slotsForOccasion, openSlotsForForm, occasionTotals, searchableFields,
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
