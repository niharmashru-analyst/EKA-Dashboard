# CORMATE Email + Password Access Control

## User access
Edit `data/users.json` and redeploy.

Example:
```json
{
  "users": {
    "user@company.com": {
      "name": "User Name",
      "password": "UserPassword",
      "access": ["stock_entry"],
      "status": "Active"
    },
    "manager@company.com": {
      "name": "Manager",
      "password": "ManagerPassword",
      "access": ["stock_entry", "dashboard"],
      "status": "Active"
    }
  }
}
```

Supported access values:
- `stock_entry`
- `dashboard`

If a user has one access, they are redirected there automatically. If they have multiple accesses, they see the CORMATE workspace chooser.

## Admin
Set these in Render Environment Variables:
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `SECRET_KEY`

The admin account automatically has stock entry, dashboard, and admin access. The admin panel is at `/admin` after login.

## Shop mapping
Keep using the existing `data/mapping.json` for email-to-shop mapping. The signed-in email is enforced by the backend for stock entry and inward APIs.

## Important
The included sample user password is `ChangeMe@2026`. Change it before production. If the repository is public, do not store real user passwords in plain text; use a private repository or switch entries to `password_hash`.


## Render environment variables

For the CORMATE login/admin system, set these on Render:

- `SECRET_KEY` — **required for production**. Use a long random value.
- `ADMIN_EMAIL` — **recommended**; defaults to `admin@cormate.com` if omitted.
- `ADMIN_PASSWORD` — **required if you want the separate Admin login**.

The following are conditional and are not required by access control itself:

- `GEMINI_API_KEY` — required only for the Analyst/Gemini chat feature.
- `MAPPING_JSON_URL` — optional; otherwise the app reads `data/mapping.json`.
- `USERS_JSON_PATH` — optional; otherwise the app reads `data/users.json`.

Existing Excel/submission/variance environment variables used by the dashboard remain as configured in your current Render service.

### Mapping JSON formats

The app accepts both the older `users` format and the VBA-generated `mappings` format:

```json
{
  "mappings": {
    "user@company.com": {
      "shops": [
        {
          "code": "S001",
          "name": "Mumbai Airport",
          "status": "Active"
        }
      ]
    }
  }
}
```

Inactive shops are ignored by the mapping loader.


## Password hashes (recommended)
`data/users.json` now stores `password_hash` instead of a plaintext `password`. To add or rotate a user:

```
python tools/hash_password.py      # prompts twice, prints a salted hash
```
Paste the output as `"password_hash"` and remove any `"password"` field. The sample user still has the
password `ChangeMe@2026` (hashed) - **rotate it before production**. See `.env.example` for all settings.
