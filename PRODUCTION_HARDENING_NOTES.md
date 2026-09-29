# Production hardening applied

- `data/mapping.json` is now the single bundled mapping source; obsolete root `mapping.json` removed.
- `SECRET_KEY` is mandatory; no fallback secret.
- Session cookies: HttpOnly, SameSite=Lax, Secure by default. Set `SESSION_COOKIE_SECURE=0` only for local HTTP testing.
- Entry metadata validates the selected shop against the signed-in user's mapping.
- `/api/submissions` is shop-scoped for normal field users; admins retain full visibility.
- Inward backend endpoints are disabled by default to match the locked UI; set `INWARD_ENABLED=1` when intentionally released.
- Gemini API key is sent in a request header, not the URL.
- Basic security response headers added.
- Variance charts inherit the restrained global chart theme.
- Dashboard table pagination controls now work.
- localStorage access is guarded.

## Render
Remove `MAPPING_JSON_URL` if it points to the old root `mapping.json`; the canonical bundled source is `data/mapping.json`.
Set a strong `SECRET_KEY`.
