import { isAdult } from "./shared.js";
export { isAdult };

// Only adults may open an occasion, lay out its slots, or close one. This
// MIRRORS the `adult_writable` policy on occasions/slots — a non-adult shown
// these controls would get a silent 403, so the client gate must match the
// server.
export function canManage(member) {
  return isAdult(member);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The human date half of a slot label. Deliberately built from UTC getters on
 * a UTC-midnight date rather than `Intl`/local getters: the input is a bare
 * `yyyy-mm-dd` with no zone, and parsing it through the device clock would
 * shift the weekday for half the world (see "Household-local dates" in
 * CLAUDE.md).
 */
export function dateLabel(isoDate) {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate ?? "";
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes past midnight, or null for anything that is not HH:MM. */
export function timeToMinutes(hhmm) {
  const m = typeof hhmm === "string" ? hhmm.match(TIME_RE) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minutesToTime(mins) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(mins / 60))}:${p(mins % 60)}`;
}

/**
 * A stored HH:MM as people read it ("2:15 PM"). The times are
 * household-local wall-clock values with no zone — they are never parsed
 * through Date, which would attach the device zone to them.
 */
export function formatTime(hhmm) {
  const mins = timeToMinutes(hhmm);
  if (mins === null) return hhmm ?? "";
  const h24 = Math.floor(mins / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(mins % 60).padStart(2, "0");
  return `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

/** The time half of a slot label: "2:00–2:15 PM", "2:00 PM", or "". */
export function timeLabel(start, end) {
  const s = formatTime(start);
  if (!s || !TIME_RE.test(start ?? "")) return "";
  if (!TIME_RE.test(end ?? "")) return s;
  const e = formatTime(end);
  // Drop the first meridiem when both halves share it: "2:00–2:15 PM".
  const [sTime, sMer] = s.split(" ");
  return e.endsWith(sMer) ? `${sTime}–${e}` : `${s}–${e}`;
}

/**
 * The human slot stored in `slots.label` and shown in the public form's
 * dropdown. The hub projects a stored column there — it cannot format a date
 * or a time — so this is the one place a label is made, and every write of
 * slot_date/start_time/end_time writes it alongside.
 */
export function slotLabel(slotDate, start, end) {
  const date = dateLabel(slotDate);
  const time = timeLabel(start, end);
  return time ? `${date} · ${time}` : date;
}

/**
 * The run of {start, end} pairs between `from` and `to`, one every
 * `everyMins` minutes — the spine of laying out a conference afternoon
 * ("every 15 minutes from 2:00 to 5:00"). With no usable interval the whole
 * window is ONE slot, which is also how a single slot is added. Bounded so a
 * typo'd interval cannot try to open hundreds of rows.
 */
export function slotTimes(from, to, everyMins, max = 96) {
  const start = timeToMinutes(from);
  if (start === null) return [];
  const stop = timeToMinutes(to);
  const hasEnd = typeof to === "string" && to.length > 0;
  if (hasEnd && (stop === null || stop <= start)) return [];
  const step = Math.floor(Number(everyMins));
  if (stop === null || !Number.isFinite(step) || step <= 0) {
    return [{ start: minutesToTime(start), end: stop !== null ? minutesToTime(stop) : "" }];
  }
  const out = [];
  for (let t = start; t + step <= stop && out.length < max; t += step) {
    out.push({ start: minutesToTime(t), end: minutesToTime(t + step) });
  }
  return out;
}

/**
 * SQLite's `datetime('now')` returns space-separated UTC ("2026-03-03 18:04:00"),
 * which JS parses as LOCAL time — an hours-wide error on every booking row,
 * since `bookings.created_at` comes from that column default rather than from
 * the app. Normalize before handing it to `Date`.
 */
export function normalizeTimestamp(ts) {
  if (typeof ts !== "string") return ts;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(" ", "T")}Z` : ts;
}

/**
 * The capacity an organizer typed. A blank or nonsense field means "leave it
 * as it was", never a default: clearing an input must not resize a slot. This
 * app has NO zero — a slot that should take nobody is `closed`, and
 * CHECK (capacity >= 1) backs that up — so the floor here is 1, which is the
 * meal-train divergence: there `capacity: 0` kept a night for the household,
 * a second door this single-ledger app does not have.
 */
export function parseCapacity(raw, fallback = 1) {
  if (raw === "" || raw === null || raw === undefined) return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

// ── the one ledger ───────────────────────────────────────────────────────────
// Every booking is a row in `bookings`, whoever made it. `capacity` bounds
// them, and the hub enforces it atomically inside the submit INSERT — the app
// only ever mirrors that predicate for display.

export function bookingsForSlot(bookings, slotId) {
  if (!slotId) return [];
  return bookings.filter((b) => b.slot_id === slotId);
}

export function bookingCount(bookings, slotId) {
  return bookingsForSlot(bookings, slotId).length;
}

/**
 * A slot has taken every booking it will accept. Mirrors the hub's own claim
 * predicate (`COUNT >= COALESCE(capacity, 0)`); capacity is never below 1
 * here (CHECK), so `full` always means real bookings spent real spots.
 */
export function isSlotFull(slot, bookings) {
  return bookingCount(bookings, slot.id) >= Number(slot.capacity || 0);
}

/**
 * What a slot is, for display. `closed` drops the slot out of the public
 * form (values_from filters on `status = open`); `full` means the form still
 * lists the occasion but this option is spent — the hub renders it disabled
 * with " (full)".
 */
export function slotState(slot, bookings) {
  if (slot.status === "closed") return "closed";
  if (isSlotFull(slot, bookings)) return "full";
  return "open";
}

export function slotsForOccasion(slots, occasionId) {
  return slots
    .filter((s) => s.occasion_id === occasionId)
    .slice()
    .sort((a, b) =>
      String(a.slot_date ?? "").localeCompare(String(b.slot_date ?? "")) ||
      String(a.start_time ?? "").localeCompare(String(b.start_time ?? "")) ||
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

/**
 * The slots a visitor would actually be offered by the share form: the same
 * `status = open` filter the manifest declares, minus the ones the hub's
 * capacity claim would refuse. The share dialog warns when this is empty,
 * because the slot select is `required` — with no pickable option the public
 * form fails closed and the link collects nothing.
 */
export function openSlotsForForm(slots, bookings, occasionId) {
  return slotsForOccasion(slots, occasionId)
    .filter((s) => s.status === "open" && !isSlotFull(s, bookings));
}

/** Progress across an occasion: how many of its offered spots are spoken for. */
export function occasionTotals(occasionId, slots, bookings) {
  const own = slotsForOccasion(slots, occasionId).filter((s) => s.status !== "closed");
  const total = own.reduce((sum, slot) => sum + Math.max(1, Number(slot.capacity || 1)), 0);
  const booked = own.reduce((sum, slot) => {
    const capacity = Math.max(1, Number(slot.capacity || 1));
    return sum + Math.min(capacity, bookingCount(bookings, slot.id));
  }, 0);
  return {
    booked,
    total,
    pct: total ? Math.min(100, Math.round((booked / total) * 100)) : 0,
    complete: total > 0 && booked >= total,
  };
}

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`). The
 * location counts as much as the title — a sheet is looked up by where it
 * happens ("Room 12") as often as by what the organizer titled it.
 */
export function searchableFields(occasion) {
  return [occasion.title, occasion.location, occasion.description];
}

// ── the household calendar export ────────────────────────────────────────────
export const CALENDAR_EXPORT_HORIZON_DAYS = 180;
export const CALENDAR_EXPORT_MAX_EVENTS = 100;

/**
 * Six months of horizon, walked in UTC off the household's own `todayIso`
 * rather than off a Date built here. Same reasoning as dateLabel(): a bare
 * `yyyy-mm-dd` carries no zone, so parsing it through the device clock moves
 * the boundary a day for half the world — and this one decides what the
 * household calendar shows.
 */
function horizonDay(todayIso) {
  if (typeof todayIso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) return todayIso ?? "";
  const [y, m, d] = todayIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + CALENDAR_EXPORT_HORIZON_DAYS * 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Build the `calendar_events` payload — the slots someone has actually BOOKED.
 *
 * Shape matches what the hub's cross-app aggregation consumes (see
 * `normalizeExportedEvent` in packages/hub/src/cloudflare/calendar-feed.ts).
 * A slot with no `start_time` becomes an all-day entry: the hub derives
 * `allDay` from the absence of a `T` in `start`, so a date-only slot degrades
 * on its own.
 *
 * Only booked slots go out, and that is the whole design. An empty 15-minute
 * slot is not an appointment — exporting a laid-out conference afternoon would
 * put 48 nothings on the household calendar and spend the 100-entry cap before
 * reaching the one time somebody is actually expected.
 *
 * `guest_name` IS exported: `bookings` is `endpoint_only` with `read:
 * "everyone"`, so every member of the scope already sees who booked, and who
 * you are meeting is the point of the entry. `guest_contact` and `guest_note`
 * are deliberately NOT — both carry a `column_read_acls` restriction to adults,
 * so they are not scope-wide readable, and this blob is scope-wide (row
 * policies do not filter it) and reaches external calendar services through the
 * household ICS feed. The occasion's own `description` is withheld for the same
 * ICS reason; `location` is exported, because telling you where to go is what a
 * calendar entry is FOR.
 */
export function buildCalendarEvents(occasions, slots, bookings, todayIso) {
  // Closed sheets are archives — their slots stay on the books but nobody is
  // expected anywhere. Only open sheets reach the calendar.
  const openById = new Map(occasions.filter((o) => (o.status ?? "open") === "open").map((o) => [o.id, o]));
  const horizon = horizonDay(todayIso);
  return slots
    .filter((s) => s.status !== "closed" && s.slot_date >= todayIso && s.slot_date <= horizon)
    .map((s) => {
      const occasion = openById.get(s.occasion_id);
      if (!occasion) return null;
      const names = bookingsForSlot(bookings, s.id).map((b) => b.guest_name).filter(Boolean);
      if (!names.length) return null;
      const start = s.start_time ? `${s.slot_date}T${s.start_time}` : s.slot_date;
      const end = s.start_time && s.end_time ? `${s.slot_date}T${s.end_time}` : start;
      return {
        id: s.id,
        // Denormalized on the slot precisely so projections that cannot re-join
        // the parent have a title; the occasion is the fallback for a row
        // written before that column existed.
        title: s.occasion_title || occasion.title || "",
        // A multi-spot slot is one appointment with several people in it, so
        // the description names all of them rather than emitting one entry each.
        description: names.join(", "),
        location: occasion.location || "",
        start,
        end,
        all_day: !s.start_time,
        // Bookings come in through the public share link from people who are
        // not household members, so there is no member to attribute this to.
        member_ids: [],
        source_label: "Booking Slots",
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, CALENDAR_EXPORT_MAX_EVENTS);
}
