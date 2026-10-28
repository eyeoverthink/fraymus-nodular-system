# Fraymus Nodular Workflow Studio

A self-hosted workflow canvas that chains prompt generation, image generation, background removal, upscaling, preview, and an API endpoint. The app starts without provider credentials and uses a local SQLite database by default.

## Run locally

Requires Node.js 22.5 or later.

```sh
npm ci
cp .env.example .env
npm run dev:all
```

Open [http://localhost:3000](http://localhost:3000). Without Supabase configured, the server uses a local development user and persists to `data/workflows.db`. Provider calls use placeholders or local processing when keys are not set.

## Configure providers

Set these in `.env` or the deployment environment:

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Llama 3.3 prompt refinement |
| `HF_TOKEN` | FLUX.1 Schnell generation and remote background-removal fallback |
| `REPLICATE_API_TOKEN` | Real-ESRGAN upscaling; Sharp Lanczos 4× is the fallback |
| `PUBLIC_URL` | Public origin used in deployed cURL snippets and Stripe checkout redirects |
| `PUBLIC_API_URL` | Public API origin when the UI is hosted separately |
| `ALLOWED_ORIGINS` | Comma-separated exact browser origins allowed to call the API |
| `PORT` | HTTP port (default `3000`) |

FLUX uses Hugging Face Inference; the server falls back to a labeled SVG when the token is absent. Background removal first uses IMG.LY's local ONNX model, and falls back to Hugging Face or Sharp if model setup fails. First local model use can take time to download. The Sharp resize is a genuine 4× dimension change, but is not AI enhancement.

**License note:** `@imgly/background-removal-node` is AGPL-licensed. Review its terms before distributing this app commercially.

## Persistent storage and authentication

For production, configure Supabase Auth and Postgres:

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
3. Keep the service-role key server-side only. Set a stable `API_KEY_HASH_SECRET` for deployed API-key verification. The API validates user access tokens with Supabase Auth, associates workflows and runs with their owner, and uses the service key only for server-side database access.

Without those three values the app uses the durable SQLite development store and does not enforce sign-in. Do not expose that local mode to the public internet.

## External frontend hosting

The static canvas can be hosted separately (including on a site builder) while this Node server runs on Railway, Fly.io, or another Node host:

1. Deploy this server and set `PUBLIC_API_URL` to its HTTPS origin and `ALLOWED_ORIGINS` to the exact frontend origin(s), comma-separated. Do not use `*`.
2. Set the hosted frontend's `<meta name="workflow-api-url" content="https://your-api.example">` to that API origin. The frontend reads the public API origin from this value; no provider or service-role credentials belong in browser code.
3. Configure the frontend host's own Content Security Policy to allow connections to the API and Supabase Auth origins.
4. Configure Supabase Auth URL allowlists for the hosted frontend, if using Supabase sign-in.

The API handles CORS preflight for authorized origins and exposes upscale dimension headers. Dashboard workflow CRUD and REA require Supabase Auth configured on this server; its deployed run endpoint can be called with the API key. Do not put a private deployed API key in browser code: browser users can inspect it. For a public customer-facing site, proxy execution through a trusted server function and add server-side quotas/payment entitlement checks before advertising free trials or unlimited runs. This repository does not currently enforce a three-run trial or verify one-time Stripe Payment Links.

This project currently uses a small native Node HTTP server and HTTP-based REA suggestions; it does not depend on Fastify or maintain Socket.io/WebSocket connections.

## Workflow API

Create a workflow with `POST /api/workflows`, edit it with `PATCH /api/workflows/:id`, and run it with `POST /api/workflows/:id/run`:

```sh
curl -X POST http://localhost:3000/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{"name":"Product images"}'
```

The create response includes the workflow ID. In the UI choose **Deploy API** to generate a one-time API key and a ready-to-copy cURL command. The key is stored as a SHA-256 hash and only shown in the deployment response; deploying again rotates it. A run accepts `{"prompt":"..."}` or a base64 PNG, JPEG, or WebP data URL in `image` to send directly to the remover. Responses include the image, HTML, and `X-Upscale-From` / `X-Upscale-To` headers.

REA suggestions are available at `POST /api/rea/suggest`. Suggestions are heuristic without a Groq key and use Llama when configured; they update as the node chain changes.

## Billing

Configure `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_METER_EVENT_NAME` to enable checkout and usage metering. Add a Stripe webhook for `POST /api/billing/webhook` and subscribe to `checkout.session.completed`. The webhook signature is verified before storing the Stripe customer mapping; completed runs are sent as meter events only for users with a mapped Stripe customer.

## Docker deployment

```sh
docker build -t fraymus-workflows .
docker run --env-file .env -p 3000:3000 -v fraymus-data:/app/data fraymus-workflows
```

Railway and Fly.io can deploy the included Dockerfile. For persistent SQLite, attach a volume at `/app/data`; otherwise configure Supabase. Set `PUBLIC_URL` to the HTTPS deployment origin.

## Tests

```sh
npm test
npm run test:workflow
```

The integration test starts the server with `MOCK_AI=1`, executes the entire five-node workflow, verifies 4096×4096 output dimensions, checks deployed API-key access, and checks the one-node REA suggestion. It does not call paid or hosted AI services.
