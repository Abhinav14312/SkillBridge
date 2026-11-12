import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { Buffer } from 'node:buffer';
import express from 'express';

const app = express();
const COOKIE = 'skillbridge.sid';
const SESSION_TTL = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const authAttempts = new Map();
const adminEmails = () => new Set((env.ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
const db = () => env.skillbridge_db;
const stmt = (sql, values = []) => db().prepare(sql).bind(...values);
const get = async (sql, ...values) => stmt(sql, values).first();
const all = async (sql, ...values) => (await stmt(sql, values).all()).results;
const run = async (sql, ...values) => stmt(sql, values).run();
const runId = async (sql, ...values) => {
  const result = await run(sql, ...values);
  return Number(result.meta.last_row_id);
};
const batch = async (statements) => {
  if (statements.length) await db().batch(statements);
};
const clean = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64url = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));

async function sessionKey() {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET with at least 32 characters in Cloudflare Worker secrets.');
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSession(data) {
  const payload = b64url(encoder.encode(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + SESSION_TTL })));
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(), encoder.encode(payload));
  return `${payload}.${b64url(signature)}`;
}

async function readSession(token) {
  if (!token) return {};
  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !await crypto.subtle.verify('HMAC', await sessionKey(), unb64url(signature), encoder.encode(payload))) return {};
    const sessionData = JSON.parse(decoder.decode(unb64url(payload)));
    if (!sessionData.exp || sessionData.exp < Date.now() / 1000) return {};
    return sessionData;
  } catch { return {}; }
}

async function setSession(res, data) {
  const token = await signSession(data);
  res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`);
}

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  const part = header.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return `pbkdf2-sha256$100000$${b64url(salt)}$${b64url(derived)}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, iterations, salt, expected] = String(stored || '').split('$');
  if (algorithm !== 'pbkdf2-sha256' || iterations !== '100000' || !salt || !expected) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64url(salt), iterations: 100000 }, key, 256));
  const target = unb64url(expected);
  if (actual.length !== target.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ target[index];
  return difference === 0;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(async (req, _res, next) => {
  req.session = await readSession(cookieValue(req, COOKIE));
  next();
});

const googleEnabled = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const googleCallbackUrl = (req) => env.GOOGLE_CALLBACK_URL || `https://${req.get('host')}/auth/google/callback`;

async function currentUser(id) {
  const user = await get('SELECT id, name, email, bio, hero_persona AS heroPersona FROM users WHERE id = ?', id);
  return user ? { ...user, isAdmin: adminEmails().has(user.email.toLowerCase()) } : null;
}

async function requireUser(req, res, next) {
  const userId = Number(req.session.userId);
  if (!userId) return res.status(401).json({ error: 'Please sign in first.' });
  const user = await get('SELECT suspended FROM users WHERE id = ?', userId);
  if (!user || user.suspended) {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res.status(403).json({ error: 'This account is unavailable. Contact SkillBridge support.' });
  }
  req.userId = userId;
  next();
}

async function requireAdmin(req, res, next) {
  const user = await currentUser(req.userId);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Moderator access required.' });
  next();
}

function limitAuthAttempts(req, res, next) {
  const key = req.get('cf-connecting-ip') || req.ip || 'unknown';
  const now = Date.now();
  const attempt = authAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return next();
  }
  if (attempt.count >= 20) return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
  attempt.count += 1;
  next();
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/auth-options', (_req, res) => res.json({ googleEnabled: googleEnabled() }));

app.get('/auth/google', async (req, res) => {
  if (!googleEnabled()) return res.redirect('/?authError=google_not_configured');
  const state = crypto.randomUUID().replaceAll('-', '');
  await setSession(res, { googleOAuthState: state });
  const query = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCallbackUrl(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!googleEnabled() || !req.session.googleOAuthState || req.query.state !== req.session.googleOAuthState || !req.query.code) {
    return res.redirect('/?authError=google_failed');
  }
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: googleCallbackUrl(req), grant_type: 'authorization_code' }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) throw new Error('Google token exchange failed');
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) throw new Error('Google did not return a verified email address');
    let user = await get('SELECT id, suspended FROM users WHERE google_id = ?', profile.sub);
    if (!user) {
      const email = String(profile.email).toLowerCase();
      const existing = await get('SELECT id, google_id, suspended FROM users WHERE email = ?', email);
      if (existing?.google_id && existing.google_id !== profile.sub) throw new Error('This email is linked to another Google account');
      if (existing) {
        await run('UPDATE users SET google_id = ? WHERE id = ?', profile.sub, existing.id);
        user = existing;
      } else {
        const id = await runId('INSERT INTO users (name, email, password_hash, google_id) VALUES (?, ?, ?, ?)', clean(profile.name || profile.email.split('@')[0], 80), email, `google-only$${crypto.randomUUID()}`, profile.sub);
        user = { id, suspended: 0 };
      }
    }
    if (user.suspended) return res.redirect('/?authError=account_unavailable');
    await setSession(res, { userId: user.id });
    res.redirect('/?signedIn=google');
  } catch (error) {
    console.error('Google sign-in failed:', error.message);
    res.redirect('/?authError=google_failed');
  }
});

app.get('/api/me', async (req, res) => {
  const userId = Number(req.session.userId);
  if (!userId) return res.json({ user: null });
  const [user, status] = await Promise.all([currentUser(userId), get('SELECT suspended FROM users WHERE id = ?', userId)]);
  if (!user || !status || status.suspended) {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res.json({ user: null });
  }
  res.json({ user, skills: await all('SELECT kind, name FROM skills WHERE user_id = ? ORDER BY name', user.id) });
});

app.post('/api/register', limitAuthAttempts, async (req, res) => {
  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) return res.status(400).json({ error: 'Enter a name, valid email, and password with at least 8 characters.' });
  try {
    const id = await runId('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', name, email, await hashPassword(password));
    await setSession(res, { userId: id });
    return res.status(201).json({ user: await currentUser(id), skills: [] });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) return res.status(409).json({ error: 'That email is already registered.' });
    throw error;
  }
});

app.post('/api/login', limitAuthAttempts, async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = await get('SELECT id, name, email, bio, password_hash, suspended FROM users WHERE email = ?', email);
  if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (user.suspended) return res.status(403).json({ error: 'This account is unavailable. Contact SkillBridge support.' });
  await setSession(res, { userId: user.id });
  res.json({ user: await currentUser(user.id), skills: await all('SELECT kind, name FROM skills WHERE user_id = ? ORDER BY name', user.id) });
});

app.post('/api/logout', (_req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.put('/api/profile', requireUser, async (req, res) => {
  const name = clean(req.body.name, 80);
  const bio = clean(req.body.bio, 500);
  const heroPersona = ['spark', 'guardian', 'inventor', 'voyager', 'oracle'].includes(req.body.heroPersona) ? req.body.heroPersona : 'spark';
  if (name.length < 2) return res.status(400).json({ error: 'Name must have at least 2 characters.' });
  const teach = Array.isArray(req.body.teach) ? req.body.teach.map((value) => clean(value, 60)).filter(Boolean).slice(0, 20) : [];
  const learn = Array.isArray(req.body.learn) ? req.body.learn.map((value) => clean(value, 60)).filter(Boolean).slice(0, 20) : [];
  const statements = [stmt('UPDATE users SET name = ?, bio = ?, hero_persona = ? WHERE id = ?', [name, bio, heroPersona, req.userId]), stmt('DELETE FROM skills WHERE user_id = ?', [req.userId])];
  for (const skill of teach) statements.push(stmt('INSERT OR IGNORE INTO skills (user_id, kind, name) VALUES (?, ?, ?)', [req.userId, 'teach', skill]));
  for (const skill of learn) statements.push(stmt('INSERT OR IGNORE INTO skills (user_id, kind, name) VALUES (?, ?, ?)', [req.userId, 'learn', skill]));
  await batch(statements);
  res.json({ user: await currentUser(req.userId), skills: await all('SELECT kind, name FROM skills WHERE user_id = ? ORDER BY name', req.userId) });
});

app.get('/api/feed', async (_req, res) => {
  res.json({ posts: await all(`SELECT posts.id, posts.body, posts.created_at AS createdAt, users.id AS userId, users.name
    FROM posts JOIN users ON users.id = posts.user_id WHERE users.suspended = 0 ORDER BY posts.id DESC LIMIT 100`) });
});

app.get('/api/communities', async (req, res) => {
  const userId = Number(req.session.userId) || -1;
  const communities = await all(`SELECT c.id, c.name, c.description, c.created_at AS createdAt,
    (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id) AS memberCount,
    EXISTS(SELECT 1 FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = ?) AS joined
    FROM communities c ORDER BY memberCount DESC, c.name`, userId);
  res.json({ communities: communities.map((community) => ({ ...community, joined: Boolean(community.joined) })) });
});

app.post('/api/communities', requireUser, async (req, res) => {
  const name = clean(req.body.name, 60);
  const description = clean(req.body.description, 500);
  if (name.length < 3 || description.length < 10) return res.status(400).json({ error: 'Enter a community name and a description of at least 10 characters.' });
  try {
    const id = await runId('INSERT INTO communities (name, description, created_by) VALUES (?, ?, ?)', name, description, req.userId);
    await run('INSERT INTO community_members (community_id, user_id) VALUES (?, ?)', id, req.userId);
    res.status(201).json({ community: await get('SELECT id, name, description, created_at AS createdAt FROM communities WHERE id = ?', id) });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) return res.status(409).json({ error: 'A community with that name already exists.' });
    throw error;
  }
});

app.post('/api/communities/:id/join', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!await get('SELECT id FROM communities WHERE id = ?', id)) return res.status(404).json({ error: 'Community not found.' });
  await run('INSERT OR IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)', id, req.userId);
  res.json({ joined: true });
});

app.get('/api/communities/:id/posts', async (req, res) => {
  const id = Number(req.params.id);
  const community = await get('SELECT id, name, description FROM communities WHERE id = ?', id);
  if (!community) return res.status(404).json({ error: 'Community not found.' });
  const joined = Boolean(req.session.userId && await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', id, req.session.userId));
  res.json({ community, joined, posts: await all(`SELECT p.id, p.body, p.created_at AS createdAt, u.id AS userId, u.name FROM community_posts p JOIN users u ON u.id = p.user_id WHERE p.community_id = ? ORDER BY p.id DESC LIMIT 100`, id) });
});

app.get('/api/communities/:id/room', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const community = await get('SELECT id, name, description FROM communities WHERE id = ?', id);
  if (!community) return res.status(404).json({ error: 'Community not found.' });
  community.joined = Boolean(await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', id, req.userId));
  const discussions = await all(`SELECT d.id, d.title, d.body, d.created_at AS createdAt, u.name, u.id AS userId FROM community_discussions d JOIN users u ON u.id = d.user_id WHERE d.community_id = ? ORDER BY d.id DESC LIMIT 100`, id);
  for (const discussion of discussions) discussion.comments = await all(`SELECT c.id, c.body, c.created_at AS createdAt, u.name, u.id AS userId FROM discussion_comments c JOIN users u ON u.id = c.user_id WHERE c.discussion_id = ? ORDER BY c.id`, discussion.id);
  res.json({ community, discussions });
});

app.get('/api/communities/:id/messages', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', id, req.userId)) return res.status(403).json({ error: 'Join this community to view its chat.' });
  const after = Number(req.query.after) || 0;
  const messages = after
    ? await all(`SELECT m.id, m.body, m.created_at AS createdAt, u.name, u.hero_persona AS heroPersona, m.user_id AS userId FROM community_messages m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND m.id > ? ORDER BY m.id LIMIT 100`, id, after)
    : (await all(`SELECT m.id, m.body, m.created_at AS createdAt, u.name, u.hero_persona AS heroPersona, m.user_id AS userId FROM community_messages m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? ORDER BY m.id DESC LIMIT 100`, id)).reverse();
  res.json({ messages });
});

app.post('/api/communities/:id/messages', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  if (!await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', id, req.userId)) return res.status(403).json({ error: 'Join this community to chat.' });
  const messageId = await runId('INSERT INTO community_messages (community_id, user_id, body) VALUES (?, ?, ?)', id, req.userId, body);
  res.status(201).json({ message: await get(`SELECT m.id, m.body, m.created_at AS createdAt, u.name, u.hero_persona AS heroPersona, m.user_id AS userId FROM community_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`, messageId) });
});

app.post('/api/communities/:id/discussions', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const title = clean(req.body.title, 120);
  const body = clean(req.body.body, 5000);
  if (!title || !body) return res.status(400).json({ error: 'Add a title and discussion text.' });
  if (!await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', id, req.userId)) return res.status(403).json({ error: 'Join this community to start a discussion.' });
  const discussionId = await runId('INSERT INTO community_discussions (community_id, user_id, title, body) VALUES (?, ?, ?, ?)', id, req.userId, title, body);
  res.status(201).json({ discussion: await get(`SELECT d.id, d.title, d.body, d.created_at AS createdAt, u.name, u.id AS userId FROM community_discussions d JOIN users u ON u.id = d.user_id WHERE d.id = ?`, discussionId) });
});

app.post('/api/discussions/:id/comments', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const body = clean(req.body.body, 2000);
  const discussion = await get('SELECT community_id FROM community_discussions WHERE id = ?', id);
  if (!discussion) return res.status(404).json({ error: 'Discussion not found.' });
  if (!await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', discussion.community_id, req.userId)) return res.status(403).json({ error: 'Join this community to comment.' });
  if (!body) return res.status(400).json({ error: 'Write a comment first.' });
  const commentId = await runId('INSERT INTO discussion_comments (discussion_id, user_id, body) VALUES (?, ?, ?)', id, req.userId, body);
  res.status(201).json({ comment: await get(`SELECT c.id, c.body, c.created_at AS createdAt, u.name, u.id AS userId FROM discussion_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, commentId) });
});

app.delete('/api/discussions/:id', requireUser, async (req, res) => {
  const result = await run('DELETE FROM community_discussions WHERE id = ? AND user_id = ?', Number(req.params.id), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Discussion not found or not yours.' });
  res.json({ ok: true });
});
app.put('/api/discussions/:id', requireUser, async (req, res) => {
  const title = clean(req.body.title, 120); const body = clean(req.body.body, 5000);
  if (!title || !body) return res.status(400).json({ error: 'Add a title and discussion text.' });
  const result = await run('UPDATE community_discussions SET title = ?, body = ? WHERE id = ? AND user_id = ?', title, body, Number(req.params.id), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Discussion not found or not yours.' });
  res.json({ ok: true });
});
app.delete('/api/discussions/:discussionId/comments/:commentId', requireUser, async (req, res) => {
  const result = await run('DELETE FROM discussion_comments WHERE id = ? AND discussion_id = ? AND user_id = ?', Number(req.params.commentId), Number(req.params.discussionId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Comment not found or not yours.' });
  res.json({ ok: true });
});
app.put('/api/discussions/:discussionId/comments/:commentId', requireUser, async (req, res) => {
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Write a comment first.' });
  const result = await run('UPDATE discussion_comments SET body = ? WHERE id = ? AND discussion_id = ? AND user_id = ?', body, Number(req.params.commentId), Number(req.params.discussionId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Comment not found or not yours.' });
  res.json({ ok: true });
});
app.delete('/api/communities/:communityId/messages/:messageId', requireUser, async (req, res) => {
  const result = await run('DELETE FROM community_messages WHERE id = ? AND community_id = ? AND user_id = ?', Number(req.params.messageId), Number(req.params.communityId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Message not found or not yours.' });
  res.json({ ok: true });
});
app.put('/api/communities/:communityId/messages/:messageId', requireUser, async (req, res) => {
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  const result = await run('UPDATE community_messages SET body = ? WHERE id = ? AND community_id = ? AND user_id = ?', body, Number(req.params.messageId), Number(req.params.communityId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Message not found or not yours.' });
  res.json({ ok: true });
});
app.delete('/api/communities/:id/membership', requireUser, async (req, res) => {
  await run('DELETE FROM community_members WHERE community_id = ? AND user_id = ?', Number(req.params.id), req.userId);
  res.json({ ok: true });
});
app.post('/api/communities/:id/posts', requireUser, async (req, res) => {
  const id = Number(req.params.id); const body = clean(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'Write a post first.' });
  if (!await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', id, req.userId)) return res.status(403).json({ error: 'Join this community to post.' });
  const postId = await runId('INSERT INTO community_posts (community_id, user_id, body) VALUES (?, ?, ?)', id, req.userId, body);
  res.status(201).json({ post: await get(`SELECT p.id, p.body, p.created_at AS createdAt, u.id AS userId, u.name FROM community_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`, postId) });
});

app.post('/api/posts', requireUser, async (req, res) => {
  const body = clean(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'Write a post first.' });
  const id = await runId('INSERT INTO posts (user_id, body) VALUES (?, ?)', req.userId, body);
  res.status(201).json({ post: await get(`SELECT posts.id, posts.body, posts.created_at AS createdAt, users.id AS userId, users.name FROM posts JOIN users ON users.id = posts.user_id WHERE posts.id = ?`, id) });
});

app.get('/api/members', async (req, res) => {
  const userId = Number(req.session.userId) || -1;
  const members = await all(`SELECT u.id, u.name, u.bio, u.hero_persona AS heroPersona,
    CASE
      WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status = 'accepted' AND ((c.requester_id = ? AND c.recipient_id = u.id) OR (c.requester_id = u.id AND c.recipient_id = ?))) THEN 'accepted'
      WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status = 'pending' AND c.requester_id = u.id AND c.recipient_id = ?) THEN 'incoming'
      WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status = 'pending' AND c.requester_id = ? AND c.recipient_id = u.id) THEN 'outgoing'
      ELSE 'none'
    END AS connectionStatus,
    (SELECT c.id FROM connections c WHERE c.status = 'pending' AND c.requester_id = u.id AND c.recipient_id = ? LIMIT 1) AS incomingRequestId
    FROM users u WHERE u.id != ? AND u.suspended = 0 ORDER BY u.id DESC LIMIT 100`, userId, userId, userId, userId, userId, userId);
  for (const member of members) {
    member.teach = (await all("SELECT name FROM skills WHERE user_id = ? AND kind = 'teach' ORDER BY name", member.id)).map((item) => item.name);
    member.learn = (await all("SELECT name FROM skills WHERE user_id = ? AND kind = 'learn' ORDER BY name", member.id)).map((item) => item.name);
  }
  res.json({ members });
});

app.get('/api/connections', requireUser, async (req, res) => {
  const userId = req.userId;
  const [incoming, outgoing, accepted] = await Promise.all([
    all(`SELECT c.id AS requestId, u.id AS userId, u.name, u.bio, u.hero_persona AS heroPersona, c.created_at AS createdAt FROM connections c JOIN users u ON u.id = c.requester_id WHERE c.recipient_id = ? AND c.status = 'pending' AND u.suspended = 0 ORDER BY c.id DESC`, userId),
    all(`SELECT c.id AS requestId, u.id AS userId, u.name, u.bio, u.hero_persona AS heroPersona, c.created_at AS createdAt FROM connections c JOIN users u ON u.id = c.recipient_id WHERE c.requester_id = ? AND c.status = 'pending' AND u.suspended = 0 ORDER BY c.id DESC`, userId),
    all(`SELECT u.id AS userId, u.name, u.bio, u.hero_persona AS heroPersona FROM connections c JOIN users u ON u.id = CASE WHEN c.requester_id = ? THEN c.recipient_id ELSE c.requester_id END WHERE (c.requester_id = ? OR c.recipient_id = ?) AND c.status = 'accepted' AND u.suspended = 0 ORDER BY u.name COLLATE NOCASE`, userId, userId, userId),
  ]);
  res.json({ incoming, outgoing, accepted });
});

app.post('/api/connections/requests/:requestId/respond', requireUser, async (req, res) => {
  const action = req.body.action;
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'Choose accept or decline.' });
  const result = await run("UPDATE connections SET status = ? WHERE id = ? AND recipient_id = ? AND status = 'pending'", action === 'accept' ? 'accepted' : 'declined', Number(req.params.requestId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Request not found or already handled.' });
  res.json({ ok: true });
});

async function hasAcceptedConnection(firstId, secondId) {
  return Boolean(await get("SELECT 1 FROM connections WHERE status = 'accepted' AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))", firstId, secondId, secondId, firstId));
}

app.post('/api/connections/:id', requireUser, async (req, res) => {
  const otherId = Number(req.params.id);
  if (!Number.isInteger(otherId) || !await get('SELECT 1 FROM users WHERE id = ? AND suspended = 0', otherId)) return res.status(404).json({ error: 'Member not found.' });
  if (otherId === req.userId) return res.status(400).json({ error: 'You cannot connect with yourself.' });
  if (await hasAcceptedConnection(req.userId, otherId)) return res.status(409).json({ error: 'You are already connected.' });
  const existing = await get('SELECT id, status FROM connections WHERE requester_id = ? AND recipient_id = ?', req.userId, otherId);
  if (existing?.status === 'accepted') return res.status(409).json({ error: 'You are already connected.' });
  if (existing?.status === 'pending') return res.status(409).json({ error: 'Your request is already pending.' });
  if (existing?.status === 'declined') {
    await run("UPDATE connections SET status = 'pending', created_at = CURRENT_TIMESTAMP WHERE id = ?", existing.id);
    return res.status(201).json({ ok: true });
  }
  if (await get("SELECT id FROM connections WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'", otherId, req.userId)) return res.status(409).json({ error: 'This member already requested to connect. Accept their request in Messages.' });
  try {
    await run('INSERT INTO connections (requester_id, recipient_id) VALUES (?, ?)', req.userId, otherId);
    res.status(201).json({ ok: true });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) return res.status(409).json({ error: 'You have already sent a request.' });
    throw error;
  }
});

app.get('/api/direct-messages/:userId', requireUser, async (req, res) => {
  const otherId = Number(req.params.userId);
  if (!await get('SELECT 1 FROM users WHERE id = ? AND suspended = 0', otherId) || !await hasAcceptedConnection(req.userId, otherId)) return res.status(403).json({ error: 'Private messages are available after a connection request is accepted.' });
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  const sql = `SELECT m.id, m.sender_id AS senderId, m.recipient_id AS recipientId, m.body, m.created_at AS createdAt, u.hero_persona AS senderPersona FROM direct_messages m JOIN users u ON u.id = m.sender_id WHERE ${after ? 'm.id > ? AND ' : ''}((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) ORDER BY m.id ${after ? 'ASC' : 'DESC'} LIMIT 100`;
  const values = after ? [after, req.userId, otherId, otherId, req.userId] : [req.userId, otherId, otherId, req.userId];
  const messages = await all(sql, ...values);
  res.json({ messages: after ? messages : messages.reverse() });
});

app.post('/api/direct-messages/:userId', requireUser, async (req, res) => {
  const otherId = Number(req.params.userId); const body = clean(req.body.body, 2000);
  if (!await get('SELECT 1 FROM users WHERE id = ? AND suspended = 0', otherId) || !await hasAcceptedConnection(req.userId, otherId)) return res.status(403).json({ error: 'Private messages are available after a connection request is accepted.' });
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  const id = await runId('INSERT INTO direct_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)', req.userId, otherId, body);
  res.status(201).json({ id });
});
app.delete('/api/direct-messages/:messageId', requireUser, async (req, res) => {
  const result = await run('DELETE FROM direct_messages WHERE id = ? AND sender_id = ?', Number(req.params.messageId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Message not found or you do not own it.' });
  res.json({ ok: true });
});
app.put('/api/direct-messages/:messageId', requireUser, async (req, res) => {
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const result = await run('UPDATE direct_messages SET body = ? WHERE id = ? AND sender_id = ?', body, Number(req.params.messageId), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Message not found or you do not own it.' });
  res.json({ ok: true });
});

app.get('/api/courses', async (req, res) => {
  const courses = await all(`SELECT c.id, c.title, c.category, c.description, c.instructor, c.instructor_id AS instructorId, c.premium, (SELECT COUNT(*) FROM course_lessons l WHERE l.course_id = c.id) AS lessonCount FROM courses c ORDER BY c.id DESC`);
  const enrolled = req.session.userId ? new Set((await all('SELECT course_id FROM enrollments WHERE user_id = ?', req.session.userId)).map((item) => item.course_id)) : new Set();
  res.json({ courses: courses.map((course) => ({ ...course, premium: Boolean(course.premium), enrolled: enrolled.has(course.id), mine: course.instructorId === req.session.userId })) });
});
app.get('/api/courses/:id', async (req, res) => {
  const course = await get('SELECT id, title, category, description, instructor, instructor_id AS instructorId, premium FROM courses WHERE id = ?', Number(req.params.id));
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  course.enrolled = Boolean(req.session.userId && await get('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?', req.session.userId, course.id));
  const canViewLessons = !course.premium || course.instructorId === req.session.userId || course.enrolled;
  if (!canViewLessons) return res.json({ course, lessons: [], locked: true });
  const lessons = await all(`SELECT l.id, l.title, l.content, l.position, EXISTS(SELECT 1 FROM lesson_progress p WHERE p.lesson_id = l.id AND p.user_id = ?) AS completed FROM course_lessons l WHERE l.course_id = ? ORDER BY l.position, l.id`, Number(req.session.userId) || -1, course.id);
  res.json({ course, lessons: lessons.map((lesson) => ({ ...lesson, completed: Boolean(lesson.completed) })) });
});
app.get('/api/learning', requireUser, async (req, res) => {
  const courses = await all(`SELECT c.id, c.title, c.category, c.description, c.instructor, COUNT(DISTINCT l.id) AS lessonCount, COUNT(DISTINCT p.lesson_id) AS completedLessons FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN course_lessons l ON l.course_id = c.id LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.user_id = e.user_id WHERE e.user_id = ? GROUP BY c.id ORDER BY e.created_at DESC`, req.userId);
  res.json({ courses: courses.map((course) => ({ ...course, progress: course.lessonCount ? Math.round((course.completedLessons / course.lessonCount) * 100) : 0 })) });
});

function parseCourseInput(body) {
  const title = clean(body.title, 120); const category = clean(body.category, 60); const description = clean(body.description, 2000);
  const lessons = Array.isArray(body.lessons) ? body.lessons.slice(0, 30).map((lesson) => ({ title: clean(lesson?.title, 120), content: clean(lesson?.content, 10000) })) : [];
  return { title, category, description, lessons };
}
function validCourse(course) {
  return !(course.title.length < 4 || course.category.length < 2 || course.description.length < 20 || !course.lessons.length || course.lessons.some((lesson) => lesson.title.length < 3 || lesson.content.length < 20));
}
function courseValidationError(res) {
  return res.status(400).json({ error: 'Add a title, category, course description, and at least one lesson with its content.' });
}
app.post('/api/courses', requireUser, async (req, res) => {
  const course = parseCourseInput(req.body);
  if (!validCourse(course)) return courseValidationError(res);
  try {
    const user = await currentUser(req.userId);
    const id = await runId('INSERT INTO courses (title, category, description, instructor, instructor_id, premium) VALUES (?, ?, ?, ?, ?, 0)', course.title, course.category, course.description, user.name, req.userId);
    const statements = course.lessons.map((lesson, index) => stmt('INSERT INTO course_lessons (course_id, title, content, position) VALUES (?, ?, ?, ?)', [id, lesson.title, lesson.content, index + 1]));
    statements.push(stmt('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)', [req.userId, id]));
    await batch(statements);
    res.status(201).json({ id });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) return res.status(409).json({ error: 'A course with that title already exists.' });
    throw error;
  }
});
app.put('/api/courses/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id); const courseInput = parseCourseInput(req.body);
  if (!await get('SELECT id FROM courses WHERE id = ? AND instructor_id = ?', id, req.userId)) return res.status(404).json({ error: 'Course not found or you do not own it.' });
  if (!validCourse(courseInput)) return courseValidationError(res);
  try {
    const statements = [stmt('UPDATE courses SET title = ?, category = ?, description = ? WHERE id = ?', [courseInput.title, courseInput.category, courseInput.description, id]), stmt('DELETE FROM course_lessons WHERE course_id = ?', [id])];
    courseInput.lessons.forEach((lesson, index) => statements.push(stmt('INSERT INTO course_lessons (course_id, title, content, position) VALUES (?, ?, ?, ?)', [id, lesson.title, lesson.content, index + 1])));
    await batch(statements);
    res.json({ ok: true });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) return res.status(409).json({ error: 'Another course already uses that title.' });
    throw error;
  }
});
app.delete('/api/courses/:id', requireUser, async (req, res) => {
  const result = await run('DELETE FROM courses WHERE id = ? AND instructor_id = ?', Number(req.params.id), req.userId);
  if (!result.meta.changes) return res.status(404).json({ error: 'Course not found or you do not own it.' });
  res.json({ ok: true });
});
app.post('/api/courses/:id/lessons/:lessonId/complete', requireUser, async (req, res) => {
  const courseId = Number(req.params.id); const lessonId = Number(req.params.lessonId);
  if (!await get('SELECT id FROM course_lessons WHERE id = ? AND course_id = ?', lessonId, courseId)) return res.status(404).json({ error: 'Lesson not found.' });
  const course = await get('SELECT premium, instructor_id FROM courses WHERE id = ?', courseId);
  const enrolled = Boolean(await get('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?', req.userId, courseId));
  if (course?.premium && !enrolled && course.instructor_id !== req.userId) return res.status(403).json({ error: 'Access this course before marking lessons complete.' });
  await batch([stmt('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)', [req.userId, courseId]), stmt('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id) VALUES (?, ?)', [req.userId, lessonId])]);
  res.json({ ok: true });
});
app.post('/api/courses/:id/enroll', requireUser, async (req, res) => {
  const id = Number(req.params.id); const course = await get('SELECT id, premium FROM courses WHERE id = ?', id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  if (course.premium) return res.status(402).json({ error: 'Subscriptions are not connected yet. This premium course is a preview.' });
  await run('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)', req.userId, id);
  res.json({ ok: true });
});

app.post('/api/reports', requireUser, async (req, res) => {
  const targetType = clean(req.body.targetType, 30); const targetId = Number(req.body.targetId); const reason = clean(req.body.reason, 600);
  const lookup = { user: 'SELECT id FROM users WHERE id = ?', course: 'SELECT id FROM courses WHERE id = ?', discussion: 'SELECT id FROM community_discussions WHERE id = ?', comment: 'SELECT id FROM discussion_comments WHERE id = ?', group_message: 'SELECT id FROM community_messages WHERE id = ?', direct_message: 'SELECT id FROM direct_messages WHERE id = ?' }[targetType];
  if (!lookup || !Number.isInteger(targetId) || !await get(lookup, targetId)) return res.status(404).json({ error: 'The item you are reporting could not be found.' });
  if (targetType === 'user' && targetId === req.userId) return res.status(400).json({ error: 'You cannot report your own profile.' });
  if (reason.length < 5) return res.status(400).json({ error: 'Please explain the concern in at least 5 characters.' });
  res.status(201).json({ id: await runId('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)', req.userId, targetType, targetId, reason) });
});
app.get('/api/moderation/reports', requireUser, requireAdmin, async (_req, res) => {
  const reports = await all(`SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.status, r.created_at AS createdAt, u.name AS reporterName, CASE WHEN r.target_type = 'user' THEN COALESCE((SELECT suspended FROM users WHERE id = r.target_id), 0) ELSE 0 END AS targetSuspended FROM reports r JOIN users u ON u.id = r.reporter_id ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.id DESC LIMIT 200`);
  res.json({ reports });
});
app.patch('/api/moderation/users/:id/suspension', requireUser, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id); const suspended = req.body.suspended;
  if (!Number.isInteger(userId) || typeof suspended !== 'boolean') return res.status(400).json({ error: 'Choose whether to suspend or restore this account.' });
  if (userId === req.userId) return res.status(400).json({ error: 'You cannot suspend your own moderator account.' });
  const target = await get('SELECT id, email FROM users WHERE id = ?', userId);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (adminEmails().has(target.email.toLowerCase())) return res.status(403).json({ error: 'Moderator accounts cannot be suspended here.' });
  await run('UPDATE users SET suspended = ? WHERE id = ?', suspended ? 1 : 0, userId);
  res.json({ ok: true, suspended });
});
app.patch('/api/moderation/reports/:id', requireUser, requireAdmin, async (req, res) => {
  const status = req.body.status;
  if (!['reviewed', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Choose reviewed or dismissed.' });
  const result = await run("UPDATE reports SET status = ? WHERE id = ? AND status = 'open'", status, Number(req.params.id));
  if (!result.meta.changes) return res.status(404).json({ error: 'Open report not found.' });
  res.json({ ok: true });
});
app.delete('/api/moderation/reports/:id/content', requireUser, requireAdmin, async (req, res) => {
  const report = await get("SELECT target_type AS targetType, target_id AS targetId FROM reports WHERE id = ? AND status = 'open'", Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Open report not found.' });
  if (report.targetType === 'user') {
    const target = await get('SELECT id, email FROM users WHERE id = ?', report.targetId);
    if (target && (target.id === req.userId || adminEmails().has(target.email.toLowerCase()))) return res.status(403).json({ error: 'Moderator accounts cannot be deleted through a member report.' });
  }
  const deletes = { user: 'DELETE FROM users WHERE id = ?', course: 'DELETE FROM courses WHERE id = ?', discussion: 'DELETE FROM community_discussions WHERE id = ?', comment: 'DELETE FROM discussion_comments WHERE id = ?', group_message: 'DELETE FROM community_messages WHERE id = ?', direct_message: 'DELETE FROM direct_messages WHERE id = ?' };
  const removed = await run(deletes[report.targetType], report.targetId);
  await run("UPDATE reports SET status = 'reviewed' WHERE id = ?", Number(req.params.id));
  res.json({ ok: true, removed: Boolean(removed.meta.changes) });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(async (req, res, next) => {
  try {
    const url = new URL(req.originalUrl, `https://${req.get('host')}`);
    const request = new Request(url, { method: req.method, headers: req.headers });
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) return next();
    res.status(asset.status);
    asset.headers.forEach((value, key) => res.set(key, value));
    res.end(Buffer.from(await asset.arrayBuffer()));
  } catch (error) { next(error); }
});
app.use((error, _req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(3000);
export default httpServerHandler({ port: 3000 });

