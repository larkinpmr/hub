---
title: "PM&R Hub — Chief Handoff Guide"
subtitle: "Larkin South Miami PM&R Hub · larkinpmr.github.io"
---

# What the hub is

The hub website (**https://larkinpmr.github.io**) is built from Google Drive. Nobody edits the website itself. You edit the Google files below, and the site updates on its own within a few minutes. It is free and has nothing to renew.

**Hand these to the next chiefs every year:**

- **Chief Gmail:** larkinpmrchief@gmail.com. This account owns every Google file and the script that feeds the site.
- **GitHub account:** `larkinpmr`, signed in with the chief Gmail. It hosts the website. You only need it for design changes.
- Update the chief Gmail's **recovery phone and email** to the new chief's. If 2-step verification is on, move it to the new chief's phone. Losing this account means losing control of the hub.

# What controls what

| Google file (in the chief Drive) | What it controls on the site | Who edits it |
|---|---|---|
| **Handbooks** (Drive folder of Google Docs) | Every rotation guide and policy page: one Google Doc per page, including pictures, contacts and links | Residents (quarterly review); chiefs approve |
| **Didactic Schedule** (Google Sheet) | Lectures page, Home "next lecture", the didactics calendar | Chiefs |
| **Resident Schedule** (Google Sheet) | Schedule page, "who is on this rotation", personal cards and calendars, onboarding reminders | Chiefs |
| **Hub Control Panel** (Google Sheet) | Settings, Key Contacts, Quick Links, Announcements, the rotation list, page edits | Chiefs, or through the Chief editor |
| **Hub pictures** (Drive folder) | The pictures from the Handbook that the site shows. **Do not delete or rename it.** It can be moved into another folder. | Nobody: the script fills it |

**Site passcode:** the Control Panel **Settings** tab has a "Site passcode" row. Each phone or computer is asked for it once and then remembered. Change it each year (every device will be asked again); leave it blank to turn the passcode screen off. It keeps casual visitors out but is not real security, so keep patient information out of everything.

**Home page headline:** the Settings tab rows "Home headline" and "Home subtitle" change the big welcome line and the sentence under it. Put *asterisks* around the words that should get the theme color (for example `Everything for the year, *in one place.*`). Leave a row blank for the default; a single `-` hides the subtitle.

**Holiday themes:** on certain days the whole site switches to holiday colors on its own, then back the next day: New Year's (Dec 31–Jan 1), Valentine's Day, Match season (Match Day through March 31), St. Patrick's Day, National Doctors' Day (March 30), graduation week (June 24–30), July 4, Halloween, Thanksgiving (Thursday–Sunday) and Christmas (Dec 24–26). July 1 shows a "Welcome" greeting only. To turn them all off, set the Settings row "Holiday themes" to `off`. To preview one, add `?holiday=halloween` (or match, doctors, thanksgiving, christmas…) to the site address.

**Chief editor:** open the gear menu on the site and choose "Chief editor". It only works when you are signed in as the chief Gmail, and it edits the Control Panel tabs without opening the sheet.

# Editing the Handbooks (the rules that keep the site working)

The **Handbooks** folder holds one Google Doc per page. Its link is in the Control Panel **Settings** tab next to "Handbooks Folder".

- **The doc's name is the page title.** Rename the doc to rename the page.
- **The folder is the group** it appears under on the Rotation Guides page (Inpatient Rehab, Consult Service, Outpatient, EMG/EDX, Neurorehab, Elective). Move a doc to move it on the site. A new folder makes a new group.
- **Policies** go in the **Policies** folder and appear under Resources.
- **"Note shown on every rotation"** (in the Handbooks folder itself) appears at the top of every rotation guide. "How to edit these Handbooks" is instructions only.
- **To add a rotation:** in the right folder, open an existing guide and use File ▸ Make a copy (keeps the look), rename it, and write the guide. It appears on the site automatically. To give it a **schedule code** (so it shows in the resident schedule, "who's on this rotation" and personal calendars), add a row in the Control Panel **Rotations** tab with **exactly the same name** as the doc.
- **To remove a rotation:** move its doc to the trash (and delete its Rotations-tab row if it has one).
- Red text stays red on the site. Use it for warnings and "⚠ Confirm" notes. Pictures, tables and links all carry over; tapping a picture on the site makes it full screen.
- Keep patient information out. The website and its code are public.
- Use **Suggesting** mode for big changes, so the chiefs can review them.
- The old single "PM&R Program Handbook" doc is an archive: edits there no longer reach the site.

# Guest lecturer reminder emails

The chief Gmail can email guest lecturers automatically before their lecture (a week before by default). It checks the Didactic Schedule every morning around 8 AM, so adding or moving a lecture in the sheet is all you do.

1. **Once:** in Apps Script, run **installLectureReminders**. It creates two tabs in the Control Panel and turns on the daily check. Google will ask for permission to send email as the chief Gmail: click Allow.
2. **Lecturers tab:** one row per guest: their name as written in the Didactic Schedule's Speaker column, their email, other spellings you use (for example `Dr. Kahn; Stuart Kahn`), and "yes" under Send reminders. Residents don't go on this tab, so they never get these emails. This tab is private: the website never receives it.
3. Run **previewLectureReminders** to see the next 6 weeks of lectures and who will be emailed when. It sends nothing.
4. Run **sendTestReminder** to get a sample email in the chief inbox.

Every email sent is listed on the **Lecture Reminders** tab (and in the chief Gmail's Sent folder), and nobody gets the same reminder twice. Replies come back to the chief Gmail. Each email has **Google Calendar** and **Outlook** buttons and an attached calendar file (for Apple Calendar and other apps), so the lecturer can add the lecture, with its join link, to their calendar in one tap. Settings rows: **Lecture reminders** (`off` stops them), **Lecture reminder days** (`7`, or `7, 1` for a week before and the day before), **Didactics start time** (blank = 2:00 PM; a time in the sheet wins), **Guest lecture length (hours)** (blank = 2, so 2:00–4:00 PM), **Virtual lecture link** (added to the email and the calendar event for Virtual lectures) and **Lecture reminder signature**.

# Start of each academic year (July)

1. **Accounts:** give the new chiefs the chief Gmail and update its recovery phone/email and 2-step verification.
2. **New schedule sheets:** if you start new Didactic or Resident Schedule sheets, paste their links into Control Panel ▸ **Settings**. Keep the same layout: month columns for residents; Date / Time / Location / Topic / Speaker columns for didactics.
3. **Settings tab:** update "Academic year".
4. **Rotations tab:** check the schedule codes (for example WPB, SA, ISS) match the codes used in the new Resident Schedule. Any code the site doesn't recognize shows as plain text.
5. **Contacts and Quick Links:** update names, phones and links.
6. **Handbooks:** have residents review their rotation docs.
7. Run **checkHandbookLinks** (below) and fix anything red.

# Quarterly Handbook review

1. Residents update their rotation docs in the Handbooks folder. Chiefs accept or reject suggestions.
2. Resolve every red **"⚠ Confirm"** note: either fix the fact or delete the note.
3. In Apps Script, run **checkHandbookLinks**. Fix broken links in the Handbook. For "Private" links, open the Drive file and set sharing to "Anyone with the link".
4. Run **refreshHandbookNow** so the site picks up the changes right away.

# The Apps Script buttons

Open the **Hub Control Panel** sheet ▸ **Extensions ▸ Apps Script**. Choose a function in the menu next to "Debug" and click **Run**. The log at the bottom shows the result.

| Function | When to run it |
|---|---|
| **refreshHandbookNow** | After editing a Handbooks doc, if you want the site updated immediately (it otherwise updates within about 30 minutes). The log lists every doc it found |
| **checkHandbookLinks** | Each quarter: tests every link in every Handbooks doc and writes a **Link Check** tab in the Control Panel, problems first |
| **setupHandbooksFolder** | Already done (October 2026): it split the old single Handbook into the Handbooks folder. Don't run it again unless you rebuild from scratch |
| **testHub** | If the site says "Saved copy" or something looks missing: lists errors and sizes |
| **testCalendar** / **testMyCalendar** | To preview the didactics calendar or one resident's personal calendar |
| **installLectureReminders** / **previewLectureReminders** / **sendTestReminder** | Guest lecturer reminder emails (see above) |
| **installAutoRefresh** | Only if the automatic 5-minute refresh ever stops (check the clock icon, "Triggers", on the left) |

**If you ever paste new code into Code.gs or Admin.html:** click **Deploy ▸ Manage deployments**. For **each** of the two deployments, click the pencil, set Version to **New version**, and click **Deploy**. Without this, the site keeps running the old code. The links stay the same.

# When something looks wrong

| What you see | What to do |
|---|---|
| Site footer says **"Saved copy"** | Google could not be reached. Run **testHub** and read the "Errors" line. Most often a file link in Settings is wrong, or the file is not in the chief Drive. |
| A Handbook change isn't on the site | Run **refreshHandbookNow**, then reload the site (⌘+Shift+R or Ctrl+Shift+R). |
| A guide is missing, shows up twice, or has no schedule code | The doc name and the Rotations-tab name must match exactly (spaces and dashes are forgiven). Check the doc is a Google Doc (not a Word file) inside a folder in Handbooks. |
| A picture is missing | Run **refreshHandbookNow** and read the "Picture problem" line, if any. Make sure the **Hub pictures** folder still exists. |
| Chief editor says "Sorry, unable to open the file" | You are signed into more than one Google account. Use a private window signed in only as the chief Gmail. |
| Script asks for permission again | Click Allow with the chief account. Google sometimes asks after code changes. |

# Design changes and the backup copy

The website's look and layout live in the GitHub repository **larkinpmr/larkinpmr.github.io** (one file, `index.html`). The repo has notes for Claude (`CLAUDE.md`), so the easiest way to change the design is to open Claude, connect the repo, and describe what you want.

The site also keeps a **saved copy** of all content in the repo (`data/snapshot.json`), shown instantly and used if Google is down. After big changes, ask Claude to "rebuild the hub's saved copy" and give it the Handbooks folder downloaded from Drive (right-click ▸ Download; Drive turns the docs into Word files in a .zip). The tool for this is `tools/build_snapshot.py`.
