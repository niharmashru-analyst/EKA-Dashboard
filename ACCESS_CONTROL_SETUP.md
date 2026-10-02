# CORMATE / RENÉE Access Control

## Workspaces

Supported access values:
- `stock_entry`
- `dashboard`
- `admin`

An `admin` account automatically receives **Stock Entry + Dashboard + Admin** and can use the admin-only operational controls.

## Admin Control Center

Open `/admin` after signing in as an admin.

Admin can:
- create/edit/delete users
- activate/deactivate users
- reset passwords
- change role/designation
- assign Stock Entry / Dashboard / Admin access
- assign multiple shops to a user
- create/edit/deactivate shops
- review shop-to-user assignments
- upload stock on behalf of a user from Excel/CSV
- choose EAN / Stock / Tester columns during upload
- generate temporary secure upload links for users
- review recent submission audit records
- download configuration backups

## Shop mapping

`data/mapping.json` remains the operational email-to-shop mapping. `data/shops.json` is the shop master used by the admin panel.

## Admin login

The separate Render environment variables remain supported:
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `SECRET_KEY`

A user record containing `admin` in `access` is also treated as an admin in the current build.

## Persistence on Render

Admin edits are written to the configured JSON files immediately. Render's default filesystem is ephemeral across some redeploy/replacement events. For permanent admin changes use either:

1. a persistent Render disk, or
2. optional GitHub persistence:
   - `GITHUB_CONFIG_TOKEN`
   - `GITHUB_CONFIG_REPO`
   - `GITHUB_CONFIG_BRANCH`
   - `GITHUB_USERS_PATH`
   - `GITHUB_MAPPING_PATH`
   - `GITHUB_SHOPS_PATH`

Do not expose the GitHub token to users.
