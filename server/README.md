# VectorForge CAD relay

Alibaba's endpoints send no CORS headers, so a browser app cannot call them
directly. This relay is the bridge — same pattern as the robot simulator's
relay, with the CAD scene envelope and system prompt instead of the robot's.

## Deploy

Deploy `cad-relay-route.ts` on the same host as the robot relay
(`bnta-robot-lab-connection.zhinii.chatgpt.site`) as the route **`/api/cad-chat`**.
That host appears to be a Cloudflare/Vercel-style edge runtime (the robot relay
uses `cf-connecting-ip`); export `GET`/`POST`/`OPTIONS` as the route handlers.

Environment variables:

| var | required | default |
|---|---|---|
| `ALIBABA_API_KEY` | yes | — |
| `ALIBABA_BASE_URL` | no | `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1` |
| `ALIBABA_MODEL` | no | `qwen3.8-flash` |

The relay uses the **server-side** key; browser-supplied keys are ignored.
Origins are whitelisted to `https://zhinii.github.io` plus localhost — edit
`allowedOrigins` if you fork.

## Client settings

The app defaults to relay URL `…/api/cad-chat`. If you deploy elsewhere,
change it under **API → Relay URL**.

Rate limits: 12 requests/min per IP, 60/min global, 3 concurrent — provider
account quota remains the hard spending boundary.
