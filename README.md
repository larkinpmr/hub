# Larkin South Miami PM&R Hub

**Live site:** https://larkinpmr.github.io  
**Owner:** the shared chief Google account (larkinpmrchief@gmail.com) and the `larkinpmr` GitHub account. Hand both logins to the next chiefs each year.

Content (schedules, Handbook, contacts, links, announcements) is edited in Google Drive or the chief editor and appears on the site automatically. Only design changes touch this repository. The Google script that feeds the site is kept in `apps-script/` for reference.

---

# One-time setup

Everything below is done **once**, signed in as the shared chief Gmail (larkinpmrchief@gmail.com). After that, nobody touches code: the site reads the Handbook Doc, the two schedule Sheets, and the Hub Control Panel directly.

## How it fits together
- **Google Drive** holds everything people edit: PM&R Handbook (Doc), Didactic Schedule (Sheet), Resident Schedule (Sheet), Hub Control Panel (Sheet).
- **A small Google Apps Script** inside the Control Panel reads those files and hands them to the website. Free, lives in the chief account.
- **GitHub Pages** hosts the website for free at `https://<account>.github.io/<repo>/`. The site keeps a saved copy of everything, so it still works if Google is ever unreachable.

## Part A — Google (about 10 minutes)
1. Upload **Hub Control Panel.xlsx** to the program's Google Drive. Open it and choose **File ▸ Save as Google Sheets**. Use that Google Sheets copy from now on and delete the .xlsx.
2. In the Control Panel sheet, open **Extensions ▸ Apps Script**. Delete the sample code, paste in all of **Code.gs**, and click **Save**. Then click **+ ▸ HTML** next to *Files*, name it exactly `Admin`, replace its contents with all of **Admin.html**, and click **Save**.
3. In the function dropdown at the top, choose **testHub**, then click **Run**. Google asks for permission: choose the chief account, then **Advanced ▸ Go to (project name) ▸ Allow**. (Google shows this warning for any script it hasn't reviewed; the script only reads your files.) The log at the bottom should list Handbook characters, didactic rows and resident rows, with `Errors: []`.
4. **Public data link:** click **Deploy ▸ New deployment**, click the gear and choose **Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. **Chief editor link:** click **Deploy ▸ New deployment** again, **Web app**, **Execute as: Me**, but this time **Who has access: Only myself**. Deploy, copy that URL, and add `?page=admin` to the end. Only the chief Google account can open it; anyone else gets a Google "no access" page, and the script also refuses saves from any other account.

## Part B — GitHub (about 10 minutes)
1. Go to github.com and **Sign up** with the chief Gmail. Pick a short username (for example `larkinpmr`).
2. Click **New repository**. Name it exactly `<username>.github.io` (for us, `larkinpmr.github.io`) so the site lives at `https://larkinpmr.github.io`. Set it to **Public** (free Pages hosting requires it), and create it.
3. Click **uploading an existing file**. Unzip **larkin-pmr-hub-site.zip** on your computer and drag in everything inside it (index.html, robots.txt, the `data` and `assets` folders, including the PDFs and Word file in `assets/files`). Click **Commit changes**. If GitHub complains about the number of files, upload the `assets/files` folder in a second batch.
4. Open `data/config.json` in the repo, click the pencil icon, and paste both links from Part A:
   `{ "liveDataUrl": "https://script.google.com/macros/s/…(public)…/exec", "adminUrl": "https://script.google.com/macros/s/…(editor)…/exec?page=admin" }`. Commit.
5. Go to **Settings ▸ Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**. After a minute or two the site is live.

## Part C — Check it
0. In the Control Panel's **Settings** tab, put the site address (`https://larkinpmr.github.io/`) next to **Website address**. The editor uses it to load pages.
1. Open the site. The footer should say **Live from Google Drive**. If it says **Saved copy**, run `testHub` again (Part A step 3) and read the error it logs.
2. On the **Didactics** page, click **Google Calendar** under "Add didactics to your calendar" and confirm the lecture days appear in your calendar. (In the script editor, `testCalendar` prints the feed if you want to check it there.)

## Good to know
- Edits in Google show up on the site within about 5 minutes (the script caches for speed).
- Subscribed calendars update on the calendar app's own schedule: Google Calendar every few hours (sometimes up to a day), Apple and Outlook roughly hourly. Each didactic day is one event listing every talk and presenter.
- If you ever change Code.gs or Admin.html, use **Deploy ▸ Manage deployments**, then for **each** of the two deployments choose **Edit ▸ Version: New version ▸ Deploy**, so both links stay the same.
- **Chief editor:** open it from the gear menu on the site (or the "Chief editor" link in the footer). It edits Contacts, Quick links, Announcements, Rotations, Settings, and any page (fix text, hide an unused template, add a new template or policy). Edits appear on the site on the next refresh. Rotation and policy content should still be changed in the Program Handbook whenever possible; the editor says so at the top.
- If the editor shows "Sorry, unable to open the file", you're signed into more than one Google account. Open it in a private window or a browser profile signed in only as the chief account.
- The site is hidden from search engines, but anyone with the link can open it, and the GitHub repo is public. Keep patient information and anything confidential out of the Handbook, schedules, and Control Panel.
- Year-to-year upkeep instructions are in the **How to update** tab of the Control Panel.
