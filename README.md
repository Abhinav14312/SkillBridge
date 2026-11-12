# SkillBridge

SkillBridge is a community learning prototype where members share skills, join group chats and discussions, and create courses with lessons. It is an early prototype for demonstration and feedback, not a production service.

## Stack

- HTML, CSS, and browser JavaScript for the interface
- Node.js, Express, `better-sqlite3`, `express-session`, and `bcryptjs` for local development
- Cloudflare Workers, Express compatibility, and D1 for the card-free hosted version
- The original Python skill-exchange prototype remains in `app/Module.py` for reference

## Run locally

1. Install Node.js 20 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and set a private `SESSION_SECRET`.
4. Start the local app with `npm run dev` (or `npm start`).
5. Open `http://localhost:3000`.

The local Node app stores data in `skillbridge.sqlite` in this folder. The database, `.env`, `node_modules`, and Python virtual environment are excluded by `.gitignore`. Run `npm run backup` for a local database backup.

## Publish on Cloudflare Workers (free plan)

The hosted Worker uses D1 for persistent app data. The free Workers plan does not require a payment card. Free usage limits apply, including 100,000 Worker requests per day and 500 MB per D1 database. Reaching a free usage limit can temporarily stop requests or database operations until the limit resets. This configuration is for a prototype, not a production service.

1. Create a free Cloudflare account and install Node.js 20 or newer.
2. Open a terminal in this project folder and run `npx wrangler login`. Authorize Wrangler in the browser.
3. Create a D1 database with `npx wrangler d1 create skillbridge-db`. If prompted, let Wrangler update `wrangler.jsonc` and enter `DB` for the binding name.
4. Apply the schema with `npx wrangler d1 migrations apply skillbridge-db --remote`.
5. Set the session signing secret with `npx wrangler secret put SESSION_SECRET` and enter a long random value when prompted. To enable moderation, also run `npx wrangler secret put ADMIN_EMAILS` and enter the admin email.
6. Deploy using `npm run cf:deploy`. Wrangler prints a public `https://….workers.dev` URL.
7. Google sign-in is optional. After deployment, add `https://YOUR-WORKER.workers.dev/auth/google/callback` to the OAuth client's authorized redirect URIs. Set the client ID and secret with `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`.

The Cloudflare Worker has a separate deployment entry at `worker.js` and uses D1's asynchronous SQLite API, signed cookie sessions, and Web Crypto password hashing. The local app remains in `server.js`. Local SQLite accounts and content are not automatically copied to D1; create a new account on the deployed site. Never commit `.env`, OAuth secrets, or other credentials.

### Reset a hosted account password

If you are signed out and cannot remember the password, run `npm run reset:cloudflare-password` from this folder in an interactive terminal. Wrangler must already be logged in with access to this project's Cloudflare account. Enter the email used on the hosted site and the new password twice; password entry is hidden. This updates only that account's password hash in the remote `skillbridge-db` D1 database. It does not require a website redeploy. Keep the new password private.

## Current MVP scope

- Account registration, login, and logout
- Optional Google sign-in
- Profiles with skills to teach and learn, plus original comic-inspired hero personas
- Home, member discovery, and member profiles
- Member-created communities with group chat and threaded discussions
- Member-created courses with lessons, enrollment, and completion tracking
- Connection requests, private messages, and moderation/reporting
- Empty states when no member-created content exists; no example courses or groups are seeded

Course payments and subscriptions, email verification, and password recovery are not connected. Group chat and private messages refresh periodically and are not end-to-end encrypted. Do not use this prototype to process real payments or sensitive personal information.

## Google sign-in setup

For local testing, create a Google OAuth **Web application** client and add `http://localhost:3000/auth/google/callback` as an authorized redirect URI. Put its client ID and secret in your local `.env` file. For Cloudflare deployment, add the Worker callback URL above to the OAuth client and set the values as Wrangler secrets. Google requires an exact redirect URI match. Keep credentials private.

## Legacy prototype

The Python CLI prototype can still be run separately with `python -m app.Module` if Python is installed. It uses in-memory demo data and is not used by the Node.js app.
