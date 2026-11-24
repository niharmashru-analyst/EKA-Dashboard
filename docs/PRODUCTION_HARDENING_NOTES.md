# Production hardening notes

- `data/mapping.json` is the canonical bundled email-to-shop mapping.
- The application now uses the bundled mapping by default. A stale `MAPPING_JSON_URL` in Render no longer overrides it.
- If a remote mapping is intentionally required, set `MAPPING_JSON_SOURCE=remote` and configure `MAPPING_JSON_URL`.
- Keep `SECRET_KEY` configured in Render with a strong random value.
- `INWARD_ENABLED=0` keeps the inward backend disabled while the UI is locked.
