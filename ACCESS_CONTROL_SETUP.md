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
      "access": ["stock_entry"]
    },
    "manager@company.com": {
      "name": "Manager",
      "password": "ManagerPassword",
      "access": ["stock_entry", "dashboard"]
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
