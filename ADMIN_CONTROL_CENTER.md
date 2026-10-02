# CORMATE Admin Control Center

The admin panel now covers the operational controls needed for RENÉE/CORMATE field stock entry.

## Admin capabilities

- Create users.
- Edit user name, role/designation and status.
- Reset a user's password without showing the existing password.
- Enable/disable Stock Entry, Dashboard and Admin access.
- Admin accounts automatically receive all three workspaces.
- Delete users and remove their shop mappings.
- Assign multiple shops to a user.
- Create/edit/disable/delete shops in the Shop Master.
- Review which users are assigned to each shop.
- Upload stock on behalf of a user.
- Upload `.xlsx`, `.xlsm` or `.csv` and choose the EAN, Stock Qty and optional Tester columns.
- Automatically skip zero rows and unknown EANs and sum duplicate EANs.
- Generate a temporary signed upload link for a specific user + shop so the user can upload their own Excel without sharing their password.
- Review recent submission audit entries across all users and shops.
- Download users, mapping and shop-master JSON backups.

## Important persistence note

The panel writes the configuration files immediately. Render's default filesystem is not a permanent database. For admin changes to survive a new deployment, configure either:

1. A Render persistent disk and point `DATABASE_PATH`/config paths there, or
2. The optional GitHub persistence variables below.

### GitHub persistence

Set these Render environment variables if you want every admin configuration save to update GitHub automatically:

- `GITHUB_CONFIG_TOKEN` — GitHub token with Contents read/write permission for the repository.
- `GITHUB_CONFIG_REPO` — `owner/repository`.
- `GITHUB_CONFIG_BRANCH` — normally `main`.
- `GITHUB_USERS_PATH` — default `data/users.json`.
- `GITHUB_MAPPING_PATH` — default `data/mapping.json`.
- `GITHUB_SHOPS_PATH` — default `data/shops.json`.

The app still updates its live runtime copy immediately. GitHub persistence is optional.

## Admin upload link

The generated URL is signed with `SECRET_KEY` and expires automatically. The token contains the target user and shop, so the recipient cannot choose another shop through that link.

## Submission backend

Use `Google_Apps_Script_Submissions_v4_Admin.gs` for the submission Google Sheet if remote submissions are enabled. It stores:

- Entry No.
- Submitted At
- Target User Email
- Store
- EAN
- Product Name
- Stock
- Tester
- Total
- Submitted By
- Submission Mode

`submission_mode` distinguishes normal field entry from `admin_upload` or other future sources.

## Render + GitHub automatic persistence

For production, configure the Admin Control Center to commit configuration changes directly to the GitHub repository that Render deploys from.

Required Render environment variables:

- `GITHUB_CONFIG_TOKEN` — a GitHub fine-grained token with **Contents: Read and write** for this repository only.
- `GITHUB_CONFIG_REPO` — `niharmashru-analyst/EKA-Dashboard` (or the exact repository connected to Render).
- `GITHUB_CONFIG_BRANCH` — `main`.
- `GITHUB_USERS_PATH` — `data/users.json`.
- `GITHUB_MAPPING_PATH` — `data/mapping.json`.
- `GITHUB_SHOPS_PATH` — `data/shops.json`.

Render must have **Auto-Deploy = Yes** for the connected GitHub branch.

Flow:

`Admin Save → GitHub commit → Render detects commit → Render deploys → new configuration is live`

The app publishes to GitHub before updating its local runtime copy. If the GitHub commit fails, the Admin save fails instead of pretending the change is permanent.
