# SkillBridge

SkillBridge is a community learning prototype where members share skills, join group chats and discussions, and create courses with lessons. It is an early prototype for demonstration and feedback, not a production service.

## Stack

- Node.js and Express for the web server and API
- SQLite (`better-sqlite3`) for local persistent data
- HTML, CSS, and browser JavaScript for the interface
- `express-session` and `bcryptjs` for basic session-based sign-in

The original Python skill-exchange prototype remains in `app/Module.py` for reference. The active app is the Node.js server.

## Run locally

1. Install Node.js 20 or newer.
2. In this folder, install dependencies with `npm install`.
3. Copy `.env.example` to `.env` and set a private `SESSION_SECRET`.
4. Start the app with `npm run dev` (or `npm start`).
5. Open `http://localhost:3000`.

## Share the prototype

Unzip the prototype package, open a terminal in the extracted `skillbridge` folder, run `npm install`, copy `.env.example` to `.env`, set a private random `SESSION_SECRET`, and run `npm start`. Add Google OAuth credentials only if you want to test Google sign-in. Each local installation creates its own SQLite database; no member data or OAuth credentials are included in the source package.

The SQLite database is created as `skillbridge.sqlite` in this folder and is excluded from version control.
Run `npm run backup` to create a timestamped local database copy in the ignored `backups/` folder. Keep a copy somewhere separate from this computer before relying on the app.

### Publish on Render

The included `render.yaml` configures a free Render web service, a generated session secret, and a health check. This is suitable for previewing the prototype, but the free service sleeps when idle and has an ephemeral filesystem. Member accounts, sessions, courses, and other SQLite data can be lost when it sleeps, restarts, or redeploys. Do not use this option for data you need to keep.

1. Put this project in a GitHub repository. Keep `.env`, database files, `node_modules`, and `venv` out of the repository; `.gitignore` excludes them.
2. In Render, choose **New > Blueprint**, connect the repository, and apply `render.yaml`. This configuration selects Render's free web service and does not attach a persistent disk.
3. Set `ADMIN_EMAILS` to the email address for the account that should have moderation access. Leave the Google OAuth values empty if you are not enabling Google sign-in.
4. Once Render gives the service its public `https://…onrender.com` address, open Google Cloud Console and add `https://YOUR-SERVICE.onrender.com/auth/google/callback` as an authorized redirect URI. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the Render service environment, then redeploy. The app derives its callback from the HTTPS request unless `GOOGLE_CALLBACK_URL` is explicitly set.
5. Share the Render URL. Register a new account on the deployed site; local accounts and the local SQLite database are not uploaded.

To keep member data reliably, switch to a paid persistent disk or migrate the app and session storage to a hosted database before inviting people to rely on saved data.

## Current MVP scope

- Account registration, login, and logout
- Google sign-in when OAuth credentials are configured
- A profile with skills to teach and learn
- Original comic-inspired hero personas and profile portraits
- A home page that explains the learning flow and a separate profile page
- Member discovery and skill profiles
- Member-created communities with group chat and threaded discussions
- Member-created courses with lessons and completion tracking
- Mission-style learning progress with XP based on completed lessons
- A My Learning page with enrolled courses and lesson completion progress
- Accepted connections with private messages on a separate Messages page
- Connection request inbox, content ownership controls, and member reports
- Moderator account suspension and restoration
- SQLite-backed sessions and sign-in rate limits
- Empty states when no member content exists; no demo courses or groups are seeded

Course payments and subscriptions, email verification, password recovery, and hosted database deployment are not connected yet. Premium course lessons stay locked until a member has access. Group chat and private messaging refresh periodically in this MVP and are not end-to-end encrypted. Add moderator emails to `ADMIN_EMAILS` to enable the moderation page. Do not use this MVP to process real payments or sensitive personal information.

### Google sign-in setup

1. In Google Cloud Console, create a project and configure the Google Auth consent screen/branding.
2. For local testing, keep the app in testing mode and add your Google account as a test user if Google asks for one.
3. Create an OAuth client with application type **Web application**.
4. Add this exact authorized redirect URI: `http://localhost:3000/auth/google/callback`.
5. Copy the client ID and client secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your local `.env` file, then restart SkillBridge.

Google requires the redirect URI sent by the app to exactly match one configured on the OAuth client. Keep `.env` private and never commit it. The sign-in button stays disabled until both values are set. For deployment, use your HTTPS domain and register its exact callback URL too.

Set `ADMIN_EMAILS` to one or more comma-separated account emails to show the moderation page, for example `ADMIN_EMAILS=you@example.com`. Set a strong random `SESSION_SECRET` in `.env` before sharing the app.

## Legacy prototype

The Python CLI prototype can still be run separately from this folder with `python -m app.Module` if Python is installed. It uses in-memory demo data and is not used by the Node.js app.
