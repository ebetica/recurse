# Stored model catalog

`models-store.json` contains the `gpt-6.1-terra` entry captured from
`https://pi.dev/api/models/providers/openai-codex?types=chat,image,classifier`
on 2026-10-28. The response Last-Modified was 2026-10-27 13:51:19 UTC and
ETag was `"95a2e44a856349a2e4505efd9edc3494"`. The provider-keyed envelope,
`models`, `lastModified`, `checkedAt`, and `etag` match Pi's FileModelsStore
format. Other models are omitted. The regression test changes only the base URL
to replay sanitized recorded provider bytes over loopback.
