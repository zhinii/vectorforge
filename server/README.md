# VectorForge CAD relay

The browser uses `/api/cad-chat` on the existing BNTA Robot Lab connection host.
Alibaba requests go through this relay so cross-origin browser requests work.
The existing robot `/api/chat` route is separate and must not be replaced.

## Authentication: explicit saved-key or BYOK mode

The public prototype defaults to `X-VectorForge-Auth: server`. The browser sends
no Authorization header. The relay reads `ALIBABA_API_KEY`, optional
`ALIBABA_BASE_URL` and `ALIBABA_MODEL`, and uses the validated fixed server model
and endpoint. The secret never goes to the browser. This public mode is deliberate;
per-isolate rate limits are not a guaranteed account spending cap.

Optional `X-VectorForge-Auth: byok` uses the tab-memory key in
`Authorization: Bearer <key>`, the chosen `model` and `X-Alibaba-Base` endpoint.
Missing mode preserves legacy BYOK. Missing/invalid BYOK credentials never fall
back to the saved key; server mode with an Authorization header is rejected.
Do not put real keys in URLs, source files, logs or committed configuration.

## Deploy and keep source in sync

Copy `cad-relay-route.ts` unchanged to `app/api/cad-chat/route.ts` in the hosted
Vinext source. Copy `cad-relay-system.mjs` alongside it under that same filename.
Build and deploy the existing Site, preserving its audience and other routes.
The default URL is:

https://bnta-robot-lab-connection.zhinii.chatgpt.site/api/cad-chat

A credential-free GET returns `auth: "server+byok"`, `defaultMode: "server"`,
`serverConfigured`, `serverModel` when configured, and `version: 2`. This is
readiness only, not a provider completion. OPTIONS from
`https://zhinii.github.io`, `http://localhost:4226`, or
`http://127.0.0.1:4226` returns 204 with the required CORS headers. A POST from an
allowed origin in BYOK mode without Authorization returns 401 with CORS, without contacting
Alibaba. Do not test with a real key unless the user approves spending.

## Request and response contract

POST JSON: `{ model, messages, max_tokens? }` (server mode ignores the client model). The last user message is JSON containing
`{ question, scene: { entities: [...] }, language?: 'en'|'zh' }`. A schema-repair attempt uses the same
envelope, optionally with `responseRepair`. The relay supplies its own CAD system
prompt and discards any browser-supplied system prompt. Success returns the
OpenAI-compatible `choices[0].message.content` and `finish_reason` fields.

Endpoint selection is exact-match allowlisted to the five Alibaba endpoints
listed in the route source. Redirects are not followed. The route limits requests
and provider responses to 64,000 bytes, each message/output to 12,000 characters,
questions to 1,600 characters, scenes to 500 entities, and output to at most 2,000 tokens. A positive integer `max_tokens` can lower
that bound, for example 1,000 for a single authorized live check.
Body receive timeout is 10 seconds; provider timeout is 25 seconds. Errors are
sanitized and have CORS headers for allowed origins.

Rate safeguards are per Worker isolate: 12 requests/minute/IP, 60/minute total,
and 3 concurrent requests. These are not distributed rate limits or a guaranteed
spending cap. Provider account quotas remain the hard spending boundary.

Run credential-free provider-mocked tests with Node 24 or newer:

`node --test server/relay.test.mjs`
