# IG Autopost

Basic single-user Instagram scheduler built for Cloudflare.

## Stack

- `apps/web`: React + Vite dashboard
- `workers/api`: Cloudflare Worker API
- D1 for accounts, scheduled posts, logs
- R2 for uploaded media
- Cron for scheduled publishing

## What it does

- Connect multiple Instagram professional accounts
- Upload one image and schedule it once
- Select one or more connected accounts per post
- Publish each post separately per selected account
- Track success and failure per account

This app publishes to Instagram. If an Instagram account already has automatic sharing to Facebook enabled inside Accounts Center, Instagram can handle the Facebook copy after the Instagram publish succeeds.

## Repo layout

```txt
.
├─ apps/
│  └─ web/
├─ workers/
│  └─ api/
└─ package.json
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
cd workers/api
npx wrangler d1 create ig_autopost
npx wrangler r2 bucket create ig-autopost-media
```

Then update `workers/api/wrangler.jsonc` with the real D1 database id and bucket name.

### 3. Apply the schema

```bash
cd workers/api
npx wrangler d1 execute ig_autopost --local --file=./schema.sql
npx wrangler d1 execute ig_autopost --remote --file=./schema.sql
```

### 4. Set secrets

Set these on the Worker:

```bash
cd workers/api
npx wrangler secret put INSTAGRAM_APP_ID
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WEB_ORIGIN
npx wrangler secret put APP_BASE_URL
npx wrangler secret put MEDIA_PUBLIC_BASE_URL
```

Expected values:

- `INSTAGRAM_APP_ID`: Meta app id
- `INSTAGRAM_APP_SECRET`: Meta app secret
- `SESSION_SECRET`: long random string for admin session cookies
- `WEB_ORIGIN`: your web app origin, for example `https://ig-autopost.pages.dev`
- `APP_BASE_URL`: your Worker origin, for example `https://ig-autopost-api.your-subdomain.workers.dev`
- `MEDIA_PUBLIC_BASE_URL`: a public base URL that serves R2 files, for example a Cloudflare public bucket domain or custom domain

### 5. Optional first-run admin gate

This app is intentionally single-user. On first run, open the dashboard and set a local admin password from the login screen. The password hash is stored in D1.

### 6. Run locally

Worker:

```bash
cd workers/api
npm run dev
```

Web:

```bash
cd apps/web
npm run dev
```

## Meta setup notes

You still need to finish the Meta side:

- create a Meta app
- add the Instagram product / permissions your app needs
- add your redirect URI: `https://YOUR_WORKER_HOST/api/auth/instagram/callback`
- connect only professional Instagram accounts you control
- make sure each selected Instagram account already has Facebook sharing configured in Accounts Center if you want downstream Facebook crossposting

## Current scope

This first pass supports image posts cleanly.

The data model and worker code already leave room for:
- reels
- carousel support
- retry controls
- timezone aware scheduling UI
- richer per-account diagnostics

## Important limits

Do not pre-create Instagram publish containers days in advance. Schedule the app to create and publish near send time. The cron worker already does that by creating media containers only when a post becomes due.

## Security model

This is not multi-user SaaS. It is one dashboard for one operator.

- simple password gate backed by D1
- httpOnly session cookie
- CORS locked to your frontend origin
- tokens kept server-side only
- uploads stored in R2
