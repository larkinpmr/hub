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
| **PM&R Program Handbook 2026-2027** (Google Doc) | Every rotation guide and policy page, including pictures, contacts and links | Residents (quarterly review); chiefs approve |
| **Didactic Schedule** (Google Sheet) | Lectures page, Home "next lecture", the didactics calendar | Chiefs |
| **Resident Schedule** (Google Sheet) | Schedule page, "who is on this rotation", personal cards and calendars, onboarding reminders | Chiefs |
| **Hub Control Panel** (Google Sheet) | Settings, Key Contacts, Quick Links, Announcements, the rotation list, page edits | Chiefs, or through the Chief editor |
| **Hub pictures** (Drive folder) | The pictures from the Handbook that the site shows. **Do not delete or rename it.** It can be moved into another folder. | Nobody: the script fills it |

**Site passcode:** the Control Panel **Settings** tab has a "Site passcode" row. Each phone or computer is asked for it once and then remembered. Change it each year (every device will be asked again); leave it blank to turn the passcode screen off. It keeps casual visitors out but is not real security, so keep patient information out of everything.

**Chief editor:** open the gear menu on the site and choose "Chief editor". It only works when you are signed in as the chief Gmail, and it edits the Control Panel tabs without opening the sheet.

# Editing the Handbook (the rules that keep the site working)

- Each rotation or policy starts with a big centered title in the **Heading 1** style. The site turns each Heading 1 into a page, so do not use Heading 1 for anything else.
- **To add a rotation:** copy an existing title (it keeps the style), rename it, and write the content below it. Then add a row in the Control Panel **Rotations** tab. Put a word from the title in "Handbook heading contains" so the site knows which page is which.
- Red text stays red on the site. Use it for warnings and "⚠ Confirm" notes.
- Pictures can be added anywhere; they show on the site, and tapping one makes it full screen.
- Keep patient information out. The website and its code are public.
- Use **Suggesting** mode for big changes, so the chiefs can review them.
- Never replace the Handbook with a new file. Edit the same Google Doc so its link stays the same. If you must switch files, paste the new link into the Control Panel **Settings** tab next to "Handbook Doc".

# Start of each academic year (July)

1. **Accounts:** give the new chiefs the chief Gmail and update its recovery phone/email and 2-step verification.
2. **New schedule sheets:** if you start new Didactic or Resident Schedule sheets, paste their links into Control Panel ▸ **Settings**. Keep the same layout: month columns for residents; Date / Time / Location / Topic / Speaker columns for didactics.
3. **Settings tab:** update "Academic year".
4. **Rotations tab:** check the schedule codes (for example WPB, SA, ISS) match the codes used in the new Resident Schedule. Any code the site doesn't recognize shows as plain text.
5. **Contacts and Quick Links:** update names, phones and links.
6. **Handbook:** update the title page year. Have residents review their rotations.
7. Run **checkHandbookLinks** (below) and fix anything red.

# Quarterly Handbook review

1. Residents update their rotation sections. Chiefs accept or reject suggestions.
2. Resolve every red **"⚠ Confirm"** note: either fix the fact or delete the note.
3. In Apps Script, run **checkHandbookLinks**. Fix broken links in the Handbook. For "Private" links, open the Drive file and set sharing to "Anyone with the link".
4. Run **refreshHandbookNow** so the site picks up the changes right away.

# The Apps Script buttons

Open the **Hub Control Panel** sheet ▸ **Extensions ▸ Apps Script**. Choose a function in the menu next to "Debug" and click **Run**. The log at the bottom shows the result.

| Function | When to run it |
|---|---|
| **refreshHandbookNow** | After editing the Handbook, if you want the site updated immediately (it otherwise updates within about 30 minutes) |
| **checkHandbookLinks** | Each quarter: tests every link in the Handbook and writes a **Link Check** tab in the Control Panel, problems first |
| **testHub** | If the site says "Saved copy" or something looks missing: lists errors and sizes |
| **testCalendar** / **testMyCalendar** | To preview the didactics calendar or one resident's personal calendar |
| **installAutoRefresh** | Only if the automatic 5-minute refresh ever stops (check the clock icon, "Triggers", on the left) |

**If you ever paste new code into Code.gs or Admin.html:** click **Deploy ▸ Manage deployments**. For **each** of the two deployments, click the pencil, set Version to **New version**, and click **Deploy**. Without this, the site keeps running the old code. The links stay the same.

# When something looks wrong

| What you see | What to do |
|---|---|
| Site footer says **"Saved copy"** | Google could not be reached. Run **testHub** and read the "Errors" line. Most often a file link in Settings is wrong, or the file is not in the chief Drive. |
| A Handbook change isn't on the site | Run **refreshHandbookNow**, then reload the site (⌘+Shift+R or Ctrl+Shift+R). |
| A rotation page shows the wrong section, or none | Check that its title is **Heading 1** and that its Rotations-tab row has a matching "Handbook heading contains" word. |
| A picture is missing | Run **refreshHandbookNow** and read the "Picture problem" line, if any. Make sure the **Hub pictures** folder still exists. |
| Chief editor says "Sorry, unable to open the file" | You are signed into more than one Google account. Use a private window signed in only as the chief Gmail. |
| Script asks for permission again | Click Allow with the chief account. Google sometimes asks after code changes. |

# Design changes and the backup copy

The website's look and layout live in the GitHub repository **larkinpmr/larkinpmr.github.io** (one file, `index.html`). The repo has notes for Claude (`CLAUDE.md`), so the easiest way to change the design is to open Claude, connect the repo, and describe what you want.

The site also keeps a **saved copy** of all content in the repo (`data/snapshot.json`), shown instantly and used if Google is down. It was last rebuilt from the master Handbook in October 2026. After big Handbook changes, ask Claude to "rebuild the hub's saved copy from the Handbook" and give it the Handbook downloaded as a Word file (File ▸ Download ▸ Microsoft Word). The tool for this is `tools/build_snapshot.py`.
