-- Booking Slots — an occasion someone is collecting time bookings for
-- (parent-teacher conferences, pickup windows, tryouts) plus the individual
-- time slots the organizer typed in.
--
-- The defining fact about this app is that the people who book are usually
-- NOT household members: they are the other parents, the buyers, the
-- families trying out. They will never install anything. So the slots table
-- is written by adults, and the bookings arrive through a writable share
-- link into `bookings`, which no app SQL may ever write (see the row
-- policies). There is deliberately NO member-side claim lane — one ledger,
-- one capacity column, and the two-ledger accounting volunteer and potluck
-- need never appears.

-- The occasion. `status` is the public gate: an occasion that is not `open`
-- disappears from every share link on it (manifest
-- shareable.occasion.visible_where). `show_bookings` gates the public
-- who's-booked feed from the shared row itself (feed parent_where) — ON for
-- a driveway sale, OFF for conferences where visitors should not see each
-- other. It defaults to 'no' because the private default is the safe one.
CREATE TABLE IF NOT EXISTS app_booking_slots__occasions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,                 -- "Parent-teacher conferences"
  location        TEXT NOT NULL DEFAULT '',      -- "Room 12" / "the driveway"
  description     TEXT NOT NULL DEFAULT '',      -- what this is, and anything bookers should know
  show_bookings   TEXT NOT NULL DEFAULT 'no',    -- 'yes' | 'no' — public feed gate, plaintext (declared)
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' (built-in plaintext)
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  -- Which app event opened this occasion, for the automation dispatcher's
  -- dedupe guard (manifest automation_actions.open_occasion). NULL for
  -- occasions an adult created in the app.
  source_event_id TEXT
);

-- One row = ONE bookable time slot. The organizer types them in (or
-- generates a run of them — "every 15 minutes from 2:00 to 5:00"), which is
-- the whole mini-Calendly premise: the slots are whatever the human said
-- they are.
--
-- `label` is the human slot ("Tue, Mar 3 · 2:00–2:15 PM") shown in the
-- share form's dropdown. The hub cannot format a date or a time for that
-- select — it projects a stored column — so the app writes one, from a
-- single helper, whenever it writes slot_date/start_time/end_time.
-- `occasion_title` is the same bargain for the Today agenda and the glance
-- tile, both of which are single-table projections that cannot re-derive
-- the parent's title per row.
--
-- `capacity` is the ONLY counter over bookings: with no member ledger there
-- is no second door, so CHECK (capacity >= 1) — a slot that should take
-- nobody is `closed`, never zero-capacity, which keeps "full" meaning what
-- it says. `start_time` is declared plaintext so the agenda and glance can
-- ORDER BY it — ciphertext orders meaninglessly.
CREATE TABLE IF NOT EXISTS app_booking_slots__slots (
  id             TEXT PRIMARY KEY,
  occasion_id    TEXT NOT NULL,
  slot_date      TEXT NOT NULL,                 -- yyyy-mm-dd, plaintext by suffix
  start_time     TEXT NOT NULL DEFAULT '',      -- HH:MM, household-local, plaintext (declared)
  end_time       TEXT NOT NULL DEFAULT '',      -- HH:MM, optional
  label          TEXT NOT NULL DEFAULT '',      -- denormalized display slot
  occasion_title TEXT NOT NULL DEFAULT '',      -- denormalized parent title
  capacity       INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  -- 'open' | 'closed'. Only 'open' slots are offered by the public form
  -- (manifest values_from.where); closing a slot is the one way to take it
  -- off the menu without deleting the bookings already on it.
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL,
  FOREIGN KEY (occasion_id) REFERENCES app_booking_slots__occasions(id) ON DELETE CASCADE
);

-- Bookings that arrived through a share link. Written ONLY by the hub's
-- external submit path; the `endpoint_only` row policy rejects every
-- app-originated INSERT/UPDATE/DELETE against it, so nothing in the app can
-- edit or erase a time an anonymous visitor booked. To clear a bogus
-- booking, the organizer removes the slot (manifest delete_cascades) and
-- lays it out again.
--
-- No foreign keys, matching meal-train's guest_claims: these rows are
-- authored outside the app, and the parent linkage is already guaranteed
-- there — `occasion_id` IS the share link's item id, and `slot_id` is
-- admitted only by an EXISTS against `slots` folded into the INSERT's own
-- WHERE, which is also what enforces `capacity` atomically.
--
-- Every column the submit path writes must be plaintext (the write path
-- never runs the app-DB codec) — see manifest.db_plaintext_columns.
-- `created_at` has a DB default because an external INSERT sets only
-- id + fk + declared fields.
CREATE TABLE IF NOT EXISTS app_booking_slots__bookings (
  id            TEXT NOT NULL PRIMARY KEY,
  occasion_id   TEXT NOT NULL,
  slot_id       TEXT NOT NULL DEFAULT '',
  guest_name    TEXT NOT NULL DEFAULT '',
  guest_contact TEXT NOT NULL DEFAULT '',       -- phone/email — read by members in-app, never fed to the public page
  guest_note    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_booking_slots__occasions_status_idx
  ON app_booking_slots__occasions (status);
CREATE INDEX IF NOT EXISTS app_booking_slots__occasions_source_event_idx
  ON app_booking_slots__occasions (source_event_id);
CREATE INDEX IF NOT EXISTS app_booking_slots__slots_occasion_idx
  ON app_booking_slots__slots (occasion_id, slot_date);
CREATE INDEX IF NOT EXISTS app_booking_slots__slots_date_idx
  ON app_booking_slots__slots (slot_date, status);
CREATE INDEX IF NOT EXISTS app_booking_slots__bookings_occasion_idx
  ON app_booking_slots__bookings (occasion_id);
CREATE INDEX IF NOT EXISTS app_booking_slots__bookings_slot_idx
  ON app_booking_slots__bookings (slot_id);
