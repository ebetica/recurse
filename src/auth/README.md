# Authentication

[Settings OAuth](oauth.ts) owns Recurse's provider sign-ins. [Codex CLI access](codex_cli.ts)
is read only so the CLI remains the sole owner of its rotating refresh token. A
saved OpenAI choice, including signing out in Settings, disables the CLI fallback.
The reader checks that choice again after reading CLI auth. It uses the same
[credential schema](provider_store.ts) as the Settings writer, so an invalid
Settings file cannot opt into CLI access. Gemini's Settings key uses a separate
[credential slot](provider_store.ts) to keep its sign-in independent of custom
endpoints. Its [Pi transport](../agents/durable/models.ts) keeps the Settings key
out of MCP and the trusted safety reviewer catalog, and removes exact key echoes
from provider streams and errors before Pi can report or store them.
