# Booking Slots

Booking Slots is a Chickadee Bandit app for publishing a set of available
times and collecting bookings through an expiring share link. It works well
for parent-teacher conferences, pickup windows, tryouts, and similar events.

Adults create a booking sheet, add individual slots or generate a timed run,
and share it externally. Visitors do not need an account. Slot capacity is
claimed atomically by the Hub, so concurrent visitors cannot take the same
last spot.

## Privacy and access

- Adults can create, edit, close, reopen, and delete booking sheets and slots.
- Every household member can see who booked a slot.
- Visitor contact information and notes are visible only to adults.
- Booking rows can only be created by the Hub's writable-share endpoint; app
  SQL cannot alter or forge them.
- Public booking names are hidden by default and can be enabled separately for
  each booking sheet.

## Development

Requires Node.js 18 or newer.

```bash
npm install
npm test
npm run build
npm run dev
```

`npm run dev` serves a local demo at <http://localhost:3001>. The demo uses
sample in-memory data because it is not connected to a Hub database.

`npm run build` writes the installable bundle to `dist/bundle.json`.

## Project layout

```text
manifest.json          App metadata, policies, sharing, automations, and surfaces
migrations/001_init.sql
src/index.html         Static app UI and Hub integration
src/logic.js           Pure booking, date, time, and capacity logic
src/shared.js          Shared role helper
scenarios.json         Hub policy and database scenarios
ui-scenarios.json      Browser-level app scenarios
__tests__/             Unit and manifest contract tests
build.mjs              Bundle builder and validation
dev.mjs                Local demo server
```

## Data model

- `occasions` stores each booking sheet.
- `slots` stores the times and capacity offered by an occasion.
- `bookings` stores anonymous share-link submissions.

Deleting an occasion removes its slots and bookings. Removing one slot removes
its bookings after a destructive confirmation. Closing either an occasion or
a slot preserves existing data while stopping new submissions.

## Hub integrations

The manifest declares:

- a shareable occasion page with an optional writable booking form;
- `booking_slots.occasion_opened` events;
- an automation action for opening a booking sheet;
- Today and glance projections over upcoming open slots; and
- `family.members` context access for role-aware controls.
