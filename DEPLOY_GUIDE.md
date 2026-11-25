# Step-by-step: upload the new version (GitHub Desktop + Render)

## 0. Pehle ye samajh lo (important)
Aapka admin panel users / shops / mapping ko **GitHub pe `data/users.json`, `data/mapping.json`, `data/shops.json` mein khud save karta hai** (GITHUB_CONFIG_TOKEN ki wajah se).
Isliye GitHub (`origin/main`) pe in 3 files ka **naya** version hota hai. Inhe zip wali purani copy se **kabhi overwrite mat karo**.
Code files (`app.py`, `extras.py`, `static/`, `templates/`, `tests/`) = zip wali **nayi** rakho.

## 1. Backup (2 minute)
1. GitHub Desktop → Repository → **Open in Explorer**.
2. `data` folder ko copy karke Desktop pe `data_backup` naam se rakh lo.

## 2. Agar merge-conflict wali screen khuli hai
1. **Abort merge** dabao. (Kuch nahi bigdega.)

## 3. Naya code daalo
1. Repo folder kholo (Explorer). **`.git` folder aur `data` folder ko haath mat lagao.** (`.git` hidden hota hai, delete mat karna.)
2. Baaki purani files/folders delete karo: `app.py`, `static`, `templates`, `tests`, `tools`, `docs`, `*.md`, `Procfile`, `requirements*.txt`, `.env.example`.
3. Naya `EKA_Dashboard_11.zip` extract karo. Andar ke folder se ye sab repo mein copy karo: `app.py`, `extras.py`, `static`, `templates`, `tests`, `tools`, `docs`, `README.md`, `DEPLOY_GUIDE.md`, `Procfile`, `requirements.txt`, `requirements-dev.txt`, `.env.example`.
   **`data` folder zip se copy MAT karo** (aapka repo wala data hi rehne do).
   Agar kabhi `data` zip se aa gaya, toh `data_backup` ya GitHub wala version wapas rakho.
4. GitHub Desktop mein changes dikhenge. Summary likho: `v11: sales dashboard, reports, theme, autosave, camera`. **Commit to main**.

## 4. Push (agar "pull first" bole ya conflict aaye)
1. **Fetch origin** → **Pull origin**. Agar conflict aaye:
   - `data/users.json`, `data/mapping.json`, `data/shops.json` (aur `data/manual_link.json`) → ▾ → **Use the added file from origin/main**
   - **baaki sab files** (extras.py, entry.js, dashboard.css, reports.js …) → ▾ → **Use the added file from main**
   - **Continue merge**.
2. **Push origin**.

## 5. Render (deploy)
1. Render → aapki service → **Events**: push ke baad auto-deploy shuru hota hai (3–5 min). Na ho toh **Manual Deploy → Deploy latest commit**.
2. **Environment** tab mein ye add/check karo:
   | Key | Value |
   |---|---|
   | `SALES_EXCEL_URL` | (optional) SharePoint link. Ya Admin page mein paste karo |
   | `DATABASE_PATH` | `/var/data/submissions.db` |
   | `SALES_FILE` | `/var/data/sales.xlsx` |
   | `ENTRY_SESSION_ENFORCE` | `0` |
   | `REPORT_TZ` | `Asia/Kolkata` |
   | `MASTER_JSON_TOKEN` | (optional) koi lamba random text, agar doosre system ko master JSON dena ho |
3. **Disks** (paid plan): ek disk banao, mount path `/var/data`. Iske bina drafts aur uploaded sales file har deploy pe ud jaate hain. Free plan hai toh `SALES_EXCEL_URL` (SharePoint) use karo.
4. Deploy ke baad `https://<aapki-site>/healthz` kholo → `{"ok": true ...}` dikhna chahiye.

## 6. Deploy ke baad check (10 minute)
1. Login karo (admin) → **Admin → Users**: jin logon ko Sales dashboard / Stock Reports dene hain unke **Sales / Reports** checkbox tick karo → Save.
2. **Admin → Upload → Sales data**: SharePoint link paste → **Save link & test**. (SharePoint mein "Anyone with the link can view" hona chahiye.)
3. Neeche "Match outlet names" aaye toh har naam ke saamne sahi shop chuno → **Save matches**.
4. Target sheet (Excel mein `Target` tab: Name, Target) bharo, taaki Target vs Achievement aur Pending dikhe.
5. Phone pe `/entry` kholo → shop → "Continue" → upar hari **Auto-save on** chip aur **Scan barcode with camera** button dikhna chahiye.
6. `/sales`, `/reports` ek baar khol ke dekho. Dark/Light button upar kone mein hai.

## 7. Android APK (naya, camera ke saath) — GitHub khud banayega
Is zip mein Android project bhi hai (`app/`, `build.gradle`, `keystore/`, `.github/workflows/build-apk.yml`). APK aapko khud build nahi karni, **GitHub Actions** banata hai:
1. Step 3–4 ki tarah **poora zip** repo mein daalo (is baar `app`, `gradle`, `keystore`, `.github`, `build.gradle`, `settings.gradle`, `gradle.properties`, `gradlew*` bhi — hidden `.github` folder bhi copy karna!). Commit + Push.
2. GitHub.com pe repo kholo → **Actions** tab → **Build Android APK** → agar apne aap shuru nahi hua toh **Run workflow** dabao.
3. 5–8 minute mein green ✓ aayega. Wo APK apne aap `static/downloads/EKA-Analytics-Android.apk` mein commit ho jaati hai, aur Render redeploy karke site ke "Android APK" button pe laga deta hai.
   Backup ke liye usi run ke neeche **Artifacts → EKA-Analytics-Android** se bhi download kar sakte ho.
4. GitHub Desktop mein **Fetch origin / Pull origin** karo (bot ka commit aayega).
5. Phone: **purana CORMATE app uninstall karo** (pehli baar sirf; naya app ab hamesha ek hi key se sign hoga), phir site ke button se naya APK install karo → Scan pe **Allow**.
Agar Actions red ✗ aaye toh uska log (red step) ka screenshot bhej do.
**Note:** signing key `keystore/eka-release.jks` repo mein hai. Repo **private** rakho.

## 8. Kuch gadbad ho toh (rollback)
GitHub Desktop → **History** → pichla theek commit → right-click → **Revert changes in commit** → Push. Render apne aap purana version chala dega.
