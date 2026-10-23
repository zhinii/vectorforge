# VectorForge CAD relay

The browser uses `/api/cad-chat` on the existing BNTA Robot Lab connection host.
Alibaba requests go through this relay so cross-origin browser requests work.
The existing robot `/api/chat` route is separate and must not be replaced.

## Authentication: bring your own key

VectorForge keeps the pasted key in memory for the current tab. The request sends
it as `Authorization: Bearer <key>` over HTTPS to the relay, which forwards it
only to the selected allowlisted Alibaba endpoint for that request. This route
does not read `ALIBABA_API_KEY`, store keys, log them, or fall back to a shared key.
Do not paste a key into a chat prompt, URL, source file, or committed configuration.
The user-selected model is sent as `model`; `X-Alibaba-Base` selects the endpoint.

No environment variables are required for this CAD route. Any environment
variables used by the existing robot route are unrelated and are left unchanged.

## Deploy and keep source in sync

Copy `cad-relay-route.ts` unchanged to `app/api/cad-chat/route.ts` in the hosted
Vinext source. Copy `cad-relay-system.mjs` alongside it under that same filename.
Build and deploy the existing Site, preserving its audience and other routes.
The default URL is:

https://bnta-robot-lab-connection.zhinii.chatgpt.site/api/cad-chat

A credential-free GET returns `auth: "byok"`. OPTIONS from
`https://zhinii.github.io`, `http://localhost:4226`, or
`http://127.0.0.1:4226` returns 204 with the required CORS headers. A POST from an
allowed origin without Authorization returns 401 with CORS, without contacting
Alibaba. Do not test with a real key unless the user approves spending.

## Request and response contract

POST JSON: `{ model, messages }`. The last user message is JSON containing
`{ question, scene: { entities: [...] } }`. A schema-repair attempt uses the same
envelope, optionally with `responseRepair`. The relay supplies its own CAD system
prompt and discards any browser-supplied system prompt. Success returns the
OpenAI-compatible `choices[0].message.content` and `finish_reason` fields.

Endpoint selection is exact-match allowlisted to the five Alibaba endpoints
listed in the route source. Redirects are not followed. The route limits requests
and provider responses to 64,000 bytes, each message/output to 12,000 characters,
questions to 1,600 characters, scenes to 500 entities, and output to 2,000 tokens.
Body receive timeout is 10 seconds; provider timeout is 25 seconds. Errors are
sanitized and have CORS headers for allowed origins.

Rate safeguards are per Worker isolate: 12 requests/minute/IP, 60/minute total,
and 3 concurrent requests. These are not distributed rate limits or a guaranteed
spending cap. Provider account quotas remain the hard spending boundary.

Run credential-free provider-mocked tests with Node 24 or newer:

`node --test server/relay.test.mjs`
