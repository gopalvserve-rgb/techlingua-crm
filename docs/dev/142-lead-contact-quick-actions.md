# dev/142 — Lead contact quick-action icons (Phone · Copy · WhatsApp · Note)

Web-only UI batch. No API change, no migration.

## What changed
Added a single reusable **`ContactQuickActions`** component
(`web/src/contactactions.tsx`) — compact, icon-only quick actions for a lead/contact:

- **Phone / Call** → `tel:+<digits>` (E.164 digits, spaces/`+`/punctuation stripped, same
  handling as the existing `wa.me`/`tel:` links).
- **Copy** → copies the raw phone number to the clipboard via
  `navigator.clipboard.writeText`, with a graceful `execCommand('copy')` fallback and a
  "Copied" toast.
- **WhatsApp** → `https://wa.me/<digits>` in a new tab (uses `whatsapp_phone` when present,
  else falls back to the primary phone).
- **Note** → opens the existing add-note flow (no new notes backend).

Each action stops row-click propagation so the icons live inside a clickable row without
also opening the lead. Icon set reuses the app's `Ic` component; a new `copy` glyph was
added to `web/src/icons.tsx`. Styling: `.cqa` / `.cqa-ic` in `web/src/styles.css`.

Dropped into:
1. **Leads list row** (`web/src/dyn.tsx` `leadRow`) — next to the name/phone in the "Lead"
   column, across Classic list, dashboard "Recent leads" and Quick-Contact "Matching
   contacts". `leadRow(l, openLead?)` now takes `openLead` so **Note** deep-links the lead
   sheet straight to the Notes tab in edit mode.
2. **Lead detail header** (`web/src/leadsheet.tsx`) — the top quick-action bar. The existing
   Call / WhatsApp / Email / Edit pills gain a **Copy** pill and an always-on **Note** pill
   (opens the Notes tab; edit mode surfaces the add-note input). `LeadSheet` gained an
   `initialTab` prop; `Shell.tsx` `openLead(id, mode?, tab?)` carries the tab.
3. **Start Calling** (`web/src/calling.tsx`) — the batch call-queue row gets the
   Phone/Copy/WhatsApp/Note icons (Note selects that lead to log against); the worked-lead
   action bar gains **Copy** + **Note** (Note focuses the Call-note input).
4. **Today's Follow-ups** (`web/src/dyn.tsx` `FollowupRows`) — each row gets the same icons
   (`f.lead_phone` from the follow-ups payload; Note opens the lead Notes tab).

## Tests
- New `web/src/contactactions.test.tsx` (vitest): renders Phone/Copy/WhatsApp/Note for a
  lead with a phone (asserts `tel:`/`wa.me` hrefs), copies to clipboard + "Copied" toast,
  and renders safely when the phone is missing (no Call/WhatsApp links, Copy disabled).
- web `tsc --noEmit` clean; `vite build` clean; api `tsc` build clean.

## Where to verify (main agent)
- **Leads → Classic list**: each row's Lead column shows the 4 icons after the phone.
- **Dashboard "Recent leads"** and **Quick Contact → Matching contacts** rows: same icons.
- **Open any lead (detail header)**: Call · Copy · WhatsApp · Email · Note present; Copy
  toasts "Copied"; Note jumps to the Notes tab.
- **Start Calling**: pull a batch — the queue rows show the icons; the worked-lead bar shows
  Copy + Note.
- **Today's Follow-ups** (dashboard card + standalone screen): each row shows the icons.

marker: contact-quick-actions
