# רותם עדני — יומן תורים

Appointment diary for the Rotem Adani salon: React + TypeScript (Vite), Supabase (Postgres, Auth, Realtime), installable PWA.
Hebrew, full RTL, 24-hour times, `Asia/Jerusalem`.

## What it does

- **Three-column day view**, right to left: **שעה | רותם | סיון**. Each staff member has an independent schedule; both can have appointments at the same time.
- **30-minute blocks by default.** Any free block can be split into two 15-minute slots (✂ 15 button on the cell, or the **פצל ל־15 דקות** switch in the booking form). Each half can hold a different customer. Splitting is per staff member, is stored in Supabase, and never creates an appointment. An empty split block can return to 30 minutes (□ 30 button).
- Appointments of **15 / 30 / 45 / 60 minutes** (longer existing ones are kept). A 30-minute appointment may start at :15 and span two 15-minute intervals.
- **Tap a free slot → type a name → Enter.** Staff, date, time and duration are prefilled from the tapped cell. Tap an appointment to edit, move (change staff/date/time) or delete it (with confirmation and an undo).
- **Realtime sync** between the tablet and phones for new, edited, moved and deleted appointments, splits and reverts. If two devices book the same staff member at the same time, only one succeeds and the other gets a clear Hebrew message.
- Smartphone: same column order, compact sizes, optional staff filter (שניהם / רותם / סיון), defaulting to both.

## Rules enforced by the database

| Rule | Where |
|---|---|
| No overlapping appointments **per staff member** | `appointments_no_overlap_per_staff` exclusion constraint (GiST, `btree_gist`) |
| Boundaries on the 15-minute grid, same-day, ≤ 4h | check constraints + `appointments_before_write` |
| Booking at :15/:45 marks its 30-minute block as split | `appointments_after_write` trigger |
| Can't split a block an appointment runs across | `slot_splits_guard` → `BLOCK_OCCUPIED` |
| Can't revert a block while a 15-minute appointment needs it | `slot_splits_guard` → `BLOCK_HAS_SPLIT_APPOINTMENTS` |
| Concurrent writes for one staff member are serialized | `pg_advisory_xact_lock` per staff member |
| Only salon members can read or write; anonymous visitors get nothing | RLS via `shop_members` |

Tables: `shops`, `shop_members`, `staff_members`, `appointments` (with `staff_member_id`), `slot_splits` (`shop_id, staff_member_id, date, block_start_time, is_split`).

## Setup

1. **Apply the migrations** in `supabase/migrations/` (in order) to the `rotem` project, either via the SQL editor or with the CLI:
   ```bash
   supabase link --project-ref yiroirvltnyogehirqvf
   supabase db push
   ```
   The migrations are idempotent and seed the salon with two staff members, רותם and סיון.
2. **Create the users** (Authentication → Users → Add user) for Rotem and Sivan, and turn off public sign-ups.
3. **Give them access to the salon** (SQL editor):
   ```sql
   insert into public.shop_members (shop_id, user_id, role)
   select '5a10a000-0000-4000-8000-000000000001', id, 'owner'
   from auth.users where email in ('rotem@example.com', 'sivan@example.com');
   ```
4. **Configure the app**: copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
5. Deploy: Cloudflare builds and deploys this repo automatically on every push to `main` (Workers static assets, see `wrangler.toml`). Manual: `npm run deploy`. On Android, open it in Chrome and use "Add to home screen".

Without Supabase settings, or with `?demo` in the URL, the app runs in **demo mode**. Data stays in that browser and syncs live between open windows, using the same rules as the database.

## Tests

```bash
npm test                      # unit + component + integration (jsdom)
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm run test:db   # real Postgres
npm run build:preview && npm run test:e2e                                        # Chromium: RTL layout + two-device sync
```

- `tests/db`: independent staff schedules, per-staff overlaps, 45/60-minute appointments, moves, split persistence, split independence, split/revert rules, DST, **true concurrent bookings on two connections**, RLS, realtime publication.
- `src/**/*.test.ts(x)`: 15/30-minute rendering, RTL column order, the booking/split/edit/delete flows in the real UI, realtime reducer, Supabase realtime wiring, two-device sync and conflicting bookings.
- `tests/e2e`: on-screen right-to-left order and column widths at tablet (1280×800) and phone (390×844) sizes, no horizontal scroll, 15-minute cells, live sync between two windows.

## Logo

`src/assets/logo-original.jpg` is the supplied logo. `logo.png` and `public/icons/*` are the same image, cropped to its circle with no other changes. The source is small (~165 px across the circle), so the 512 px PWA icon is upscaled. Replace `logo-original.jpg` with a higher-resolution original and regenerate for crisper icons.

## Customer profiles, recurring appointments, waiting list, installable app

- **Customer profiles** — tap a customer's name in the calendar (or open "לקוחות" in the header). Profile shows phone, first/last visit, completed visits, upcoming/previous appointments, cancellations and no-shows, notes and haircut preferences, and status (New / Returning / Inactive — inactive after 90 days without a visit or booking). Edit details, "קבע תור שוב", call/WhatsApp. Cancelling now keeps the appointment in history (`appointments.status`), and its slot becomes free again.
- **Recurring appointments** — in the full booking form choose "חזרה" (every 1–4 weeks or custom; number of appointments or end date). The preview checks every date against bookings, crossed-out slots, closed weekdays (Settings), Israeli statutory rest days and opening hours; each conflict can be skipped or moved. Created atomically by `create_series` (never overwrites; a repeated request creates nothing new). Editing/cancelling asks: only this / this and following / all upcoming.
- **Waiting list** — header clock icon. Add customers with preferred dates, time range, length and staff. Matching free slots are found automatically (badge in the header; a gentle alert after a cancellation frees a matching slot). "הצע בוואטסאפ" opens WhatsApp with a prefilled Hebrew message (wa.me link, no paid API). Mark offers accepted/declined/expired; accepting books the slot via `accept_offer`, which refuses if someone else took it first.
- **Installable app (PWA)** — Hebrew manifest, icons, iPhone/iPad splash screens, standalone mode, service worker caching only the app's own static files (never Supabase/API data), offline screen, and writes blocked while offline.
  - **iPhone (Safari):** Share → "הוספה למסך הבית" → "הוסף".
  - **Android (Chrome):** ⋮ menu → "התקנת אפליקציה" (or the install button in Settings).

Tests: `npm test` (UI), `npm run test:db` (real Postgres), `npm run test:e2e` (browser), `npm run build && npm run test:pwa` (PWA; set `PWA_URL=https://…` to check a deployment).
