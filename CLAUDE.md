# Larkin South Miami PM&R Hub — notes for Claude

Static site served by GitHub Pages at https://larkinpmr.github.io (repo `larkinpmr/larkinpmr.github.io`, branch `main`, root).

- `index.html` — the whole site (HTML, CSS, JS in one file). Design changes happen here.
- `data/snapshot.json` — saved copy of all content (built from the master Handbook .docx with `tools/build_snapshot.py`; note templates and the readiness note live only here); shown instantly and used if Google is unreachable.
- `data/config.json` — `liveDataUrl` (public Apps Script web app, returns schedules/contacts; `?part=handbook` returns the Handbook; `?calendar=didactics` returns the .ics feed) and `adminUrl` (chief-only editor deployment, `?page=admin`).
- `assets/` — site icons; `assets/hb/` — Handbook pictures for the saved copy; `assets/files/` — lecture PDFs linked from the Handbook.
- `apps-script/` — copy of the Google Apps Script (Code.gs + Admin.html) that lives in the "Hub Control Panel" Google Sheet in the chief account. Editing these files here does NOT change the live script; the chief must paste them into Apps Script and create a new version of BOTH deployments.

Live content comes from Google: Didactic Schedule sheet, Resident Schedule sheet, PM&R Program Handbook doc (split by Heading 1 into rotation/policy pages), and Control Panel tabs (Settings, Contacts, Quick Links, Announcements, Rotations, Page Edits). Never hard-code schedule or contact data into index.html.

Before pushing a change: keep both light and dark themes and phone width (~390px) working, and test with a headless browser.
