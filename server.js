require('dotenv').config();

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'skillbridge.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    google_id TEXT UNIQUE,
    bio TEXT NOT NULL DEFAULT '',
    suspended INTEGER NOT NULL DEFAULT 0,
    hero_persona TEXT NOT NULL DEFAULT 'spark',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('teach', 'learn')),
    name TEXT NOT NULL,
    UNIQUE(user_id, kind, name)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS community_members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS community_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS community_discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS discussion_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discussion_id INTEGER NOT NULL REFERENCES community_discussions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(requester_id, recipient_id),
    CHECK (requester_id != recipient_id)
  );
  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    instructor TEXT NOT NULL,
    instructor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    premium INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS enrollments (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, course_id)
  );
  CREATE TABLE IF NOT EXISTS course_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS lesson_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id INTEGER NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, lesson_id)
  );
  CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('user', 'course', 'discussion', 'comment', 'group_message', 'direct_message')),
    target_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

if (!db.pragma('table_info(courses)').some((column) => column.name === 'instructor_id')) {
  db.exec('ALTER TABLE courses ADD COLUMN instructor_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

// Add the Google identity column when upgrading an existing local database.
if (!db.pragma('table_info(users)').some((column) => column.name === 'google_id')) {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_id ON users(google_id) WHERE google_id IS NOT NULL');
}
if (!db.pragma('table_info(users)').some((column) => column.name === 'suspended')) {
  db.exec('ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
}
if (!db.pragma('table_info(users)').some((column) => column.name === 'hero_persona')) {
  db.exec("ALTER TABLE users ADD COLUMN hero_persona TEXT NOT NULL DEFAULT 'spark'");
}

db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?').run(Date.now());

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT sess, expires_at FROM app_sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at <= Date.now()) {
        if (row) db.prepare('DELETE FROM app_sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare('INSERT INTO app_sessions (sid, sess, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at')
        .run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { db.prepare('DELETE FROM app_sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }

  touch(sid, sess, callback = () => {}) { this.set(sid, sess, callback); }
}

// Remove only the demo content from the earlier prototype. Real member content is retained.
db.prepare("DELETE FROM courses WHERE instructor_id IS NULL AND instructor = 'SkillBridge Community' AND title IN (?, ?, ?)").run(
  'Python for Curious Beginners', 'Guitar: Your First Five Songs', 'Personal Finance Foundations',
);
db.prepare("DELETE FROM communities WHERE created_by IS NULL AND name IN (?, ?, ?)").run(
  'Builders & Coders', 'Creative Practice', 'Money & Life Skills',
);

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be configured in production.');
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'skillbridge.sid',
  secret: process.env.SESSION_SECRET || 'local-development-secret-change-this',
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.use(express.static(path.join(__dirname, 'public')));

const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const googleCallbackUrl = (req) => process.env.GOOGLE_CALLBACK_URL || `${req.protocol}://${req.get('host')}/auth/google/callback`;
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));

app.get('/api/auth-options', (req, res) => res.json({ googleEnabled }));

app.get('/auth/google', (req, res) => {
  if (!googleEnabled) return res.redirect('/?authError=google_not_configured');
  const state = randomBytes(24).toString('hex');
  req.session.googleOAuthState = state;
  const query = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCallbackUrl(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
});

app.get('/auth/google/callback', async (req, res, next) => {
  const expectedState = req.session.googleOAuthState;
  delete req.session.googleOAuthState;
  if (!googleEnabled || !expectedState || req.query.state !== expectedState || !req.query.code) {
    return res.redirect('/?authError=google_failed');
  }
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleCallbackUrl(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) throw new Error('Google token exchange failed');

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) {
      throw new Error('Google did not return a verified email address');
    }

    let user = db.prepare('SELECT id, suspended FROM users WHERE google_id = ?').get(profile.sub);
    if (!user) {
      const existing = db.prepare('SELECT id, google_id, suspended FROM users WHERE email = ?').get(String(profile.email).toLowerCase());
      if (existing?.google_id && existing.google_id !== profile.sub) throw new Error('This email is linked to another Google account');
      if (existing) {
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(profile.sub, existing.id);
        user = existing;
      } else {
        const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
        const result = db.prepare('INSERT INTO users (name, email, password_hash, google_id) VALUES (?, ?, ?, ?)')
          .run(clean(profile.name || profile.email.split('@')[0], 80), String(profile.email).toLowerCase(), passwordHash, profile.sub);
        user = { id: Number(result.lastInsertRowid), suspended: 0 };
      }
    }
    if (user.suspended) return res.redirect('/?authError=account_unavailable');

    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      res.redirect('/?signedIn=google');
    });
  } catch (error) {
    console.error('Google sign-in failed:', error.message);
    res.redirect('/?authError=google_failed');
  }
});

const clean = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const authAttempts = new Map();
function limitAuthAttempts(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
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
const requireUser = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in first.' });
  const user = db.prepare('SELECT suspended FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.suspended) {
    return req.session.destroy(() => res.status(403).json({ error: 'This account is unavailable. Contact SkillBridge support.' }));
  }
  next();
};
const requireAdmin = (req, res, next) => {
  const user = currentUser(req.session.userId);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Moderator access required.' });
  next();
};
const currentUser = (id) => {
  const user = db.prepare('SELECT id, name, email, bio, hero_persona AS heroPersona FROM users WHERE id = ?').get(id);
  return user ? { ...user, isAdmin: adminEmails.has(user.email.toLowerCase()) } : null;
};

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = currentUser(req.session.userId);
  const status = db.prepare('SELECT suspended FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !status || status.suspended) {
    return req.session.destroy(() => res.json({ user: null }));
  }
  const skills = db.prepare('SELECT kind, name FROM skills WHERE user_id = ? ORDER BY name').all(user.id);
  res.json({ user, skills });
});

app.post('/api/register', limitAuthAttempts, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80);
    const email = clean(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
      return res.status(400).json({ error: 'Enter a name, valid email, and password with at least 8 characters.' });
    }
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(name, email, await bcrypt.hash(password, 12));
    const userId = Number(result.lastInsertRowid);
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = userId;
      res.status(201).json({ user: currentUser(userId), skills: [] });
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That email is already registered.' });
    next(error);
  }
});

app.post('/api/login', limitAuthAttempts, async (req, res, next) => {
  try {
    const email = clean(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = db.prepare('SELECT id, name, email, bio, password_hash, suspended FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    if (user.suspended) return res.status(403).json({ error: 'This account is unavailable. Contact SkillBridge support.' });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      res.json({
        user: currentUser(user.id),
        skills: db.prepare('SELECT kind, name FROM skills WHERE user_id = ? ORDER BY name').all(user.id),
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('skillbridge.sid', { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  });
});

app.put('/api/profile', requireUser, (req, res) => {
  const name = clean(req.body.name, 80);
  const bio = clean(req.body.bio, 500);
  const heroPersona = ['spark', 'guardian', 'inventor', 'voyager', 'oracle'].includes(req.body.heroPersona) ? req.body.heroPersona : 'spark';
  if (name.length < 2) return res.status(400).json({ error: 'Name must have at least 2 characters.' });
  const teach = Array.isArray(req.body.teach) ? req.body.teach.map((x) => clean(x, 60)).filter(Boolean).slice(0, 20) : [];
  const learn = Array.isArray(req.body.learn) ? req.body.learn.map((x) => clean(x, 60)).filter(Boolean).slice(0, 20) : [];
  const save = db.transaction(() => {
    db.prepare('UPDATE users SET name = ?, bio = ?, hero_persona = ? WHERE id = ?').run(name, bio, heroPersona, req.session.userId);
    db.prepare('DELETE FROM skills WHERE user_id = ?').run(req.session.userId);
    const insert = db.prepare('INSERT OR IGNORE INTO skills (user_id, kind, name) VALUES (?, ?, ?)');
    for (const skill of teach) insert.run(req.session.userId, 'teach', skill);
    for (const skill of learn) insert.run(req.session.userId, 'learn', skill);
  });
  save();
  res.json({ user: currentUser(req.session.userId), skills: db.prepare('SELECT kind, name FROM skills WHERE user_id = ? ORDER BY name').all(req.session.userId) });
});

app.get('/api/feed', (req, res) => {
  res.json({ posts: db.prepare(`
    SELECT posts.id, posts.body, posts.created_at AS createdAt, users.id AS userId, users.name
    FROM posts JOIN users ON users.id = posts.user_id
    ORDER BY posts.id DESC LIMIT 50
  `).all() });
});

app.get('/api/communities', (req, res) => {
  const communities = db.prepare(`
    SELECT c.id, c.name, c.description,
      COUNT(DISTINCT cm.user_id) AS memberCount,
      EXISTS(SELECT 1 FROM community_members mine WHERE mine.community_id = c.id AND mine.user_id = ?) AS joined
    FROM communities c
    LEFT JOIN community_members cm ON cm.community_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `).all(req.session.userId || -1);
  res.json({ communities });
});

app.post('/api/communities', requireUser, (req, res) => {
  const name = clean(req.body.name, 70);
  const description = clean(req.body.description, 300);
  if (name.length < 3 || description.length < 10) {
    return res.status(400).json({ error: 'Use a community name of at least 3 characters and a description of at least 10.' });
  }
  try {
    const create = db.transaction(() => {
      const result = db.prepare('INSERT INTO communities (name, description, created_by) VALUES (?, ?, ?)')
        .run(name, description, req.session.userId);
      db.prepare('INSERT INTO community_members (community_id, user_id) VALUES (?, ?)').run(result.lastInsertRowid, req.session.userId);
      return Number(result.lastInsertRowid);
    });
    res.status(201).json({ id: create() });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'A community with that name already exists.' });
    throw error;
  }
});

app.post('/api/communities/:id/join', requireUser, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM communities WHERE id = ?').get(id)) return res.status(404).json({ error: 'Community not found.' });
  db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)').run(id, req.session.userId);
  res.json({ ok: true });
});

app.get('/api/communities/:id/posts', (req, res) => {
  const id = Number(req.params.id);
  const community = db.prepare('SELECT id, name, description FROM communities WHERE id = ?').get(id);
  if (!community) return res.status(404).json({ error: 'Community not found.' });
  const joined = Boolean(req.session.userId && db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(id, req.session.userId));
  const posts = db.prepare(`
    SELECT p.id, p.body, p.created_at AS createdAt, u.name
    FROM community_posts p JOIN users u ON u.id = p.user_id
    WHERE p.community_id = ? ORDER BY p.id DESC LIMIT 50
  `).all(id);
  res.json({ community, joined, posts });
});

app.get('/api/communities/:id/room', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const community = db.prepare('SELECT id, name, description FROM communities WHERE id = ?').get(id);
  if (!community) return res.status(404).json({ error: 'Community not found.' });
  const joined = Boolean(db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(id, req.session.userId));

  const discussions = db.prepare(`
    SELECT d.id, d.user_id AS userId, d.title, d.body, d.created_at AS createdAt, u.name, u.hero_persona AS heroPersona,
      (SELECT COUNT(*) FROM discussion_comments c WHERE c.discussion_id = d.id) AS commentCount
    FROM community_discussions d JOIN users u ON u.id = d.user_id
    WHERE d.community_id = ? ORDER BY d.id DESC LIMIT 100
  `).all(id).map((discussion) => ({
    ...discussion,
    comments: db.prepare(`
      SELECT c.id, c.user_id AS userId, c.body, c.created_at AS createdAt, u.name, u.hero_persona AS heroPersona
      FROM discussion_comments c JOIN users u ON u.id = c.user_id
      WHERE c.discussion_id = ? ORDER BY c.id LIMIT 100
    `).all(discussion.id),
  }));
  res.json({ community: { ...community, joined }, discussions });
});

app.get('/api/communities/:id/messages', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const joined = db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(id, req.session.userId);
  if (!joined) return res.status(403).json({ error: 'Join this community to use its chat.' });
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  const messages = after
    ? db.prepare(`SELECT m.id, m.body, m.created_at AS createdAt, u.name, u.hero_persona AS heroPersona, m.user_id AS userId FROM community_messages m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND m.id > ? ORDER BY m.id LIMIT 100`).all(id, after)
    : db.prepare(`SELECT m.id, m.body, m.created_at AS createdAt, u.name, u.hero_persona AS heroPersona, m.user_id AS userId FROM community_messages m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? ORDER BY m.id DESC LIMIT 100`).all(id).reverse();
  res.json({ messages });
});

app.post('/api/communities/:id/messages', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const body = clean(req.body.body, 1000);
  if (body.length < 1) return res.status(400).json({ error: 'Write a message first.' });
  const joined = db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(id, req.session.userId);
  if (!joined) return res.status(403).json({ error: 'Join this community before chatting.' });
  const result = db.prepare('INSERT INTO community_messages (community_id, user_id, body) VALUES (?, ?, ?)').run(id, req.session.userId, body);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.post('/api/communities/:id/discussions', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const title = clean(req.body.title, 120);
  const body = clean(req.body.body, 5000);
  if (title.length < 4 || body.length < 2) return res.status(400).json({ error: 'Add a title and at least 2 characters of discussion text.' });
  const joined = db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(id, req.session.userId);
  if (!joined) return res.status(403).json({ error: 'Join this community before starting a discussion.' });
  const result = db.prepare('INSERT INTO community_discussions (community_id, user_id, title, body) VALUES (?, ?, ?, ?)').run(id, req.session.userId, title, body);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.post('/api/discussions/:id/comments', requireUser, (req, res) => {
  const discussionId = Number(req.params.id);
  const body = clean(req.body.body, 1500);
  if (body.length < 2) return res.status(400).json({ error: 'Write a reply with at least 2 characters.' });
  const discussion = db.prepare('SELECT community_id FROM community_discussions WHERE id = ?').get(discussionId);
  if (!discussion) return res.status(404).json({ error: 'Discussion not found.' });
  const joined = db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(discussion.community_id, req.session.userId);
  if (!joined) return res.status(403).json({ error: 'Join this community before replying.' });
  const result = db.prepare('INSERT INTO discussion_comments (discussion_id, user_id, body) VALUES (?, ?, ?)').run(discussionId, req.session.userId, body);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.delete('/api/discussions/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM community_discussions WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Discussion not found or you do not own it.' });
  res.json({ ok: true });
});

app.put('/api/discussions/:id', requireUser, (req, res) => {
  const title = clean(req.body.title, 120);
  const body = clean(req.body.body, 5000);
  if (title.length < 4 || body.length < 2) return res.status(400).json({ error: 'Add a title and discussion text.' });
  const result = db.prepare('UPDATE community_discussions SET title = ?, body = ? WHERE id = ? AND user_id = ?')
    .run(title, body, Number(req.params.id), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Discussion not found or you do not own it.' });
  res.json({ ok: true });
});

app.delete('/api/discussions/:discussionId/comments/:commentId', requireUser, (req, res) => {
  const result = db.prepare(`DELETE FROM discussion_comments WHERE id = ? AND discussion_id = ? AND user_id = ?`)
    .run(Number(req.params.commentId), Number(req.params.discussionId), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Reply not found or you do not own it.' });
  res.json({ ok: true });
});

app.put('/api/discussions/:discussionId/comments/:commentId', requireUser, (req, res) => {
  const body = clean(req.body.body, 1500);
  if (body.length < 2) return res.status(400).json({ error: 'Write a reply with at least 2 characters.' });
  const result = db.prepare('UPDATE discussion_comments SET body = ? WHERE id = ? AND discussion_id = ? AND user_id = ?')
    .run(body, Number(req.params.commentId), Number(req.params.discussionId), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Reply not found or you do not own it.' });
  res.json({ ok: true });
});

app.delete('/api/communities/:communityId/messages/:messageId', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM community_messages WHERE id = ? AND community_id = ? AND user_id = ?')
    .run(Number(req.params.messageId), Number(req.params.communityId), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Message not found or you do not own it.' });
  res.json({ ok: true });
});

app.put('/api/communities/:communityId/messages/:messageId', requireUser, (req, res) => {
  const body = clean(req.body.body, 1000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const result = db.prepare('UPDATE community_messages SET body = ? WHERE id = ? AND community_id = ? AND user_id = ?')
    .run(body, Number(req.params.messageId), Number(req.params.communityId), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Message not found or you do not own it.' });
  res.json({ ok: true });
});

app.delete('/api/communities/:id/membership', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(req.params.id), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'You are not a member of this community.' });
  res.json({ ok: true });
});

app.post('/api/communities/:id/posts', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const body = clean(req.body.body, 1000);
  if (body.length < 2) return res.status(400).json({ error: 'Write at least 2 characters.' });
  const joined = db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(id, req.session.userId);
  if (!joined) return res.status(403).json({ error: 'Join this community before posting.' });
  const result = db.prepare('INSERT INTO community_posts (community_id, user_id, body) VALUES (?, ?, ?)').run(id, req.session.userId, body);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.post('/api/posts', requireUser, (req, res) => {
  const body = clean(req.body.body, 1000);
  if (body.length < 2) return res.status(400).json({ error: 'Write at least 2 characters.' });
  const result = db.prepare('INSERT INTO posts (user_id, body) VALUES (?, ?)').run(req.session.userId, body);
  res.status(201).json({ post: db.prepare(`SELECT posts.id, posts.body, posts.created_at AS createdAt, users.id AS userId, users.name FROM posts JOIN users ON users.id = posts.user_id WHERE posts.id = ?`).get(result.lastInsertRowid) });
});

app.get('/api/members', (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.name, u.bio, u.hero_persona AS heroPersona,
      CASE
        WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status = 'accepted' AND ((c.requester_id = ? AND c.recipient_id = u.id) OR (c.requester_id = u.id AND c.recipient_id = ?))) THEN 'accepted'
        WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status = 'pending' AND c.requester_id = u.id AND c.recipient_id = ?) THEN 'incoming'
        WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status = 'pending' AND c.requester_id = ? AND c.recipient_id = u.id) THEN 'outgoing'
        ELSE 'none'
      END AS connectionStatus,
      (SELECT c.id FROM connections c WHERE c.status = 'pending' AND c.requester_id = u.id AND c.recipient_id = ? LIMIT 1) AS incomingRequestId
    FROM users u WHERE u.id != COALESCE(?, -1) AND u.suspended = 0 ORDER BY u.id DESC LIMIT 100
  `).all(req.session.userId || -1, req.session.userId || -1, req.session.userId || -1, req.session.userId || -1, req.session.userId || -1, req.session.userId || -1).map((user) => ({
    ...user,
    teach: db.prepare("SELECT name FROM skills WHERE user_id = ? AND kind = 'teach' ORDER BY name").all(user.id).map((x) => x.name),
    learn: db.prepare("SELECT name FROM skills WHERE user_id = ? AND kind = 'learn' ORDER BY name").all(user.id).map((x) => x.name),
  }));
  res.json({ members });
});

app.get('/api/connections', requireUser, (req, res) => {
  const userId = req.session.userId;
  const incoming = db.prepare(`
    SELECT c.id AS requestId, u.id AS userId, u.name, u.bio, u.hero_persona AS heroPersona, c.created_at AS createdAt
    FROM connections c JOIN users u ON u.id = c.requester_id
    WHERE c.recipient_id = ? AND c.status = 'pending' AND u.suspended = 0 ORDER BY c.id DESC
  `).all(userId);
  const outgoing = db.prepare(`
    SELECT c.id AS requestId, u.id AS userId, u.name, u.bio, u.hero_persona AS heroPersona, c.created_at AS createdAt
    FROM connections c JOIN users u ON u.id = c.recipient_id
    WHERE c.requester_id = ? AND c.status = 'pending' AND u.suspended = 0 ORDER BY c.id DESC
  `).all(userId);
  const accepted = db.prepare(`
    SELECT u.id AS userId, u.name, u.bio, u.hero_persona AS heroPersona
    FROM connections c JOIN users u ON u.id = CASE WHEN c.requester_id = ? THEN c.recipient_id ELSE c.requester_id END
    WHERE (c.requester_id = ? OR c.recipient_id = ?) AND c.status = 'accepted' AND u.suspended = 0
    ORDER BY u.name COLLATE NOCASE
  `).all(userId, userId, userId);
  res.json({ incoming, outgoing, accepted });
});

app.post('/api/connections/requests/:requestId/respond', requireUser, (req, res) => {
  const requestId = Number(req.params.requestId);
  const action = req.body.action;
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'Choose accept or decline.' });
  const result = db.prepare(`UPDATE connections SET status = ? WHERE id = ? AND recipient_id = ? AND status = 'pending'`)
    .run(action === 'accept' ? 'accepted' : 'declined', requestId, req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Request not found or already handled.' });
  res.json({ ok: true });
});

app.post('/api/connections/:id', requireUser, (req, res) => {
  const otherId = Number(req.params.id);
  if (!Number.isInteger(otherId) || !db.prepare('SELECT 1 FROM users WHERE id = ? AND suspended = 0').get(otherId)) return res.status(404).json({ error: 'Member not found.' });
  if (otherId === req.session.userId) return res.status(400).json({ error: 'You cannot connect with yourself.' });
  try {
    const existing = db.prepare('SELECT id, status FROM connections WHERE requester_id = ? AND recipient_id = ?').get(req.session.userId, otherId);
    if (hasAcceptedConnection(req.session.userId, otherId)) return res.status(409).json({ error: 'You are already connected.' });
    if (existing?.status === 'accepted') return res.status(409).json({ error: 'You are already connected.' });
    if (existing?.status === 'pending') return res.status(409).json({ error: 'Your request is already pending.' });
    if (existing?.status === 'declined') {
      db.prepare("UPDATE connections SET status = 'pending', created_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
      return res.status(201).json({ ok: true });
    }
    const reverse = db.prepare("SELECT id FROM connections WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'").get(otherId, req.session.userId);
    if (reverse) return res.status(409).json({ error: 'This member already requested to connect. Accept their request in Messages.' });
    db.prepare('INSERT INTO connections (requester_id, recipient_id) VALUES (?, ?)').run(req.session.userId, otherId);
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'You have already sent a request.' });
    throw error;
  }
});

function hasAcceptedConnection(firstId, secondId) {
  return Boolean(db.prepare(`SELECT 1 FROM connections WHERE status = 'accepted' AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`)
    .get(firstId, secondId, secondId, firstId));
}

app.get('/api/direct-messages/:userId', requireUser, (req, res) => {
  const otherId = Number(req.params.userId);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND suspended = 0').get(otherId) || !hasAcceptedConnection(req.session.userId, otherId)) return res.status(403).json({ error: 'Private messages are available after a connection request is accepted.' });
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  const messages = after
    ? db.prepare(`SELECT m.id, m.sender_id AS senderId, m.recipient_id AS recipientId, m.body, m.created_at AS createdAt, u.hero_persona AS senderPersona FROM direct_messages m JOIN users u ON u.id = m.sender_id WHERE m.id > ? AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) ORDER BY m.id LIMIT 100`).all(after, req.session.userId, otherId, otherId, req.session.userId)
    : db.prepare(`SELECT m.id, m.sender_id AS senderId, m.recipient_id AS recipientId, m.body, m.created_at AS createdAt, u.hero_persona AS senderPersona FROM direct_messages m JOIN users u ON u.id = m.sender_id WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?) ORDER BY m.id DESC LIMIT 100`).all(req.session.userId, otherId, otherId, req.session.userId).reverse();
  res.json({ messages });
});

app.post('/api/direct-messages/:userId', requireUser, (req, res) => {
  const otherId = Number(req.params.userId);
  const body = clean(req.body.body, 2000);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND suspended = 0').get(otherId) || !hasAcceptedConnection(req.session.userId, otherId)) return res.status(403).json({ error: 'Private messages are available after a connection request is accepted.' });
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  const result = db.prepare('INSERT INTO direct_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)').run(req.session.userId, otherId, body);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.delete('/api/direct-messages/:messageId', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM direct_messages WHERE id = ? AND sender_id = ?').run(Number(req.params.messageId), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Message not found or you do not own it.' });
  res.json({ ok: true });
});

app.put('/api/direct-messages/:messageId', requireUser, (req, res) => {
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const result = db.prepare('UPDATE direct_messages SET body = ? WHERE id = ? AND sender_id = ?').run(body, Number(req.params.messageId), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Message not found or you do not own it.' });
  res.json({ ok: true });
});

app.get('/api/courses', (req, res) => {
  const courses = db.prepare(`SELECT c.id, c.title, c.category, c.description, c.instructor, c.instructor_id AS instructorId, c.premium,
    (SELECT COUNT(*) FROM course_lessons l WHERE l.course_id = c.id) AS lessonCount FROM courses c ORDER BY c.id DESC`).all();
  const enrolled = req.session.userId
    ? new Set(db.prepare('SELECT course_id FROM enrollments WHERE user_id = ?').all(req.session.userId).map((x) => x.course_id))
    : new Set();
  res.json({ courses: courses.map((course) => ({ ...course, premium: Boolean(course.premium), enrolled: enrolled.has(course.id), mine: course.instructorId === req.session.userId })) });
});

app.get('/api/courses/:id', (req, res) => {
  const course = db.prepare('SELECT id, title, category, description, instructor, instructor_id AS instructorId, premium FROM courses WHERE id = ?').get(Number(req.params.id));
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  course.enrolled = Boolean(req.session.userId && db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.session.userId, course.id));
  const canViewLessons = !course.premium || course.instructorId === req.session.userId || course.enrolled;
  if (!canViewLessons) return res.json({ course, lessons: [], locked: true });
  const lessons = db.prepare(`SELECT l.id, l.title, l.content, l.position,
    EXISTS(SELECT 1 FROM lesson_progress p WHERE p.lesson_id = l.id AND p.user_id = ?) AS completed
    FROM course_lessons l WHERE l.course_id = ? ORDER BY l.position, l.id`).all(req.session.userId || -1, course.id);
  res.json({ course, lessons });
});

app.get('/api/learning', requireUser, (req, res) => {
  const courses = db.prepare(`
    SELECT c.id, c.title, c.category, c.description, c.instructor,
      COUNT(DISTINCT l.id) AS lessonCount,
      COUNT(DISTINCT p.lesson_id) AS completedLessons
    FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN course_lessons l ON l.course_id = c.id
    LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.user_id = e.user_id
    WHERE e.user_id = ?
    GROUP BY c.id ORDER BY e.created_at DESC
  `).all(req.session.userId).map((course) => ({
    ...course,
    progress: course.lessonCount ? Math.round((course.completedLessons / course.lessonCount) * 100) : 0,
  }));
  res.json({ courses });
});

app.post('/api/courses', requireUser, (req, res) => {
  const title = clean(req.body.title, 120);
  const category = clean(req.body.category, 60);
  const description = clean(req.body.description, 2000);
  const lessons = Array.isArray(req.body.lessons) ? req.body.lessons.slice(0, 30).map((lesson) => ({
    title: clean(lesson?.title, 120),
    content: clean(lesson?.content, 10000),
  })) : [];
  if (title.length < 4 || category.length < 2 || description.length < 20 || !lessons.length || lessons.some((lesson) => lesson.title.length < 3 || lesson.content.length < 20)) {
    return res.status(400).json({ error: 'Add a title, category, course description, and at least one lesson with its content.' });
  }
  try {
    const create = db.transaction(() => {
      const result = db.prepare('INSERT INTO courses (title, category, description, instructor, instructor_id, premium) VALUES (?, ?, ?, ?, ?, 0)')
        .run(title, category, description, currentUser(req.session.userId).name, req.session.userId);
      const insertLesson = db.prepare('INSERT INTO course_lessons (course_id, title, content, position) VALUES (?, ?, ?, ?)');
      lessons.forEach((lesson, index) => insertLesson.run(result.lastInsertRowid, lesson.title, lesson.content, index + 1));
      db.prepare('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)').run(req.session.userId, result.lastInsertRowid);
      return Number(result.lastInsertRowid);
    });
    res.status(201).json({ id: create() });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'A course with that title already exists.' });
    throw error;
  }
});

app.put('/api/courses/:id', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const title = clean(req.body.title, 120);
  const category = clean(req.body.category, 60);
  const description = clean(req.body.description, 2000);
  const lessons = Array.isArray(req.body.lessons) ? req.body.lessons.slice(0, 30).map((lesson) => ({
    title: clean(lesson?.title, 120), content: clean(lesson?.content, 10000),
  })) : [];
  const course = db.prepare('SELECT id FROM courses WHERE id = ? AND instructor_id = ?').get(id, req.session.userId);
  if (!course) return res.status(404).json({ error: 'Course not found or you do not own it.' });
  if (title.length < 4 || category.length < 2 || description.length < 20 || !lessons.length || lessons.some((lesson) => lesson.title.length < 3 || lesson.content.length < 20)) {
    return res.status(400).json({ error: 'Add a title, category, course description, and at least one lesson with its content.' });
  }
  try {
    const update = db.transaction(() => {
      db.prepare('UPDATE courses SET title = ?, category = ?, description = ? WHERE id = ?').run(title, category, description, id);
      db.prepare('DELETE FROM course_lessons WHERE course_id = ?').run(id);
      const addLesson = db.prepare('INSERT INTO course_lessons (course_id, title, content, position) VALUES (?, ?, ?, ?)');
      lessons.forEach((lesson, index) => addLesson.run(id, lesson.title, lesson.content, index + 1));
    });
    update();
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Another course already uses that title.' });
    throw error;
  }
});

app.delete('/api/courses/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM courses WHERE id = ? AND instructor_id = ?').run(Number(req.params.id), req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Course not found or you do not own it.' });
  res.json({ ok: true });
});

app.post('/api/courses/:id/lessons/:lessonId/complete', requireUser, (req, res) => {
  const courseId = Number(req.params.id);
  const lessonId = Number(req.params.lessonId);
  const lesson = db.prepare('SELECT id FROM course_lessons WHERE id = ? AND course_id = ?').get(lessonId, courseId);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });
  const course = db.prepare('SELECT premium, instructor_id FROM courses WHERE id = ?').get(courseId);
  const enrolled = Boolean(db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.session.userId, courseId));
  if (course?.premium && !enrolled && course.instructor_id !== req.session.userId) return res.status(403).json({ error: 'Access this course before marking lessons complete.' });
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)').run(req.session.userId, courseId);
  db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id) VALUES (?, ?)').run(req.session.userId, lessonId);
  res.json({ ok: true });
});

app.post('/api/courses/:id/enroll', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const course = db.prepare('SELECT id, premium FROM courses WHERE id = ?').get(id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  if (course.premium) return res.status(402).json({ error: 'Subscriptions are not connected yet. This premium course is a preview.' });
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)').run(req.session.userId, id);
  res.json({ ok: true });
});

app.post('/api/reports', requireUser, (req, res) => {
  const targetType = clean(req.body.targetType, 30);
  const targetId = Number(req.body.targetId);
  const reason = clean(req.body.reason, 600);
  const lookups = {
    user: 'SELECT id FROM users WHERE id = ?',
    course: 'SELECT id FROM courses WHERE id = ?',
    discussion: 'SELECT id FROM community_discussions WHERE id = ?',
    comment: 'SELECT id FROM discussion_comments WHERE id = ?',
    group_message: 'SELECT id FROM community_messages WHERE id = ?',
    direct_message: 'SELECT id FROM direct_messages WHERE id = ?',
  };
  if (!lookups[targetType] || !Number.isInteger(targetId) || !db.prepare(lookups[targetType]).get(targetId)) {
    return res.status(404).json({ error: 'The item you are reporting could not be found.' });
  }
  if (targetType === 'user' && targetId === req.session.userId) return res.status(400).json({ error: 'You cannot report your own profile.' });
  if (reason.length < 5) return res.status(400).json({ error: 'Please explain the concern in at least 5 characters.' });
  const result = db.prepare('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)')
    .run(req.session.userId, targetType, targetId, reason);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.get('/api/moderation/reports', requireUser, requireAdmin, (req, res) => {
  const reports = db.prepare(`
    SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.status,
      r.created_at AS createdAt, u.name AS reporterName,
      CASE WHEN r.target_type = 'user' THEN COALESCE((SELECT suspended FROM users WHERE id = r.target_id), 0) ELSE 0 END AS targetSuspended
    FROM reports r JOIN users u ON u.id = r.reporter_id
    ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.id DESC LIMIT 200
  `).all();
  res.json({ reports });
});

app.patch('/api/moderation/users/:id/suspension', requireUser, requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const suspended = req.body.suspended;
  if (!Number.isInteger(userId) || typeof suspended !== 'boolean') {
    return res.status(400).json({ error: 'Choose whether to suspend or restore this account.' });
  }
  if (userId === req.session.userId) return res.status(400).json({ error: 'You cannot suspend your own moderator account.' });
  const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (adminEmails.has(target.email.toLowerCase())) return res.status(403).json({ error: 'Moderator accounts cannot be suspended here.' });
  db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, userId);
  res.json({ ok: true, suspended });
});

app.patch('/api/moderation/reports/:id', requireUser, requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!['reviewed', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Choose reviewed or dismissed.' });
  const result = db.prepare("UPDATE reports SET status = ? WHERE id = ? AND status = 'open'").run(status, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Open report not found.' });
  res.json({ ok: true });
});

app.delete('/api/moderation/reports/:id/content', requireUser, requireAdmin, (req, res) => {
  const report = db.prepare("SELECT target_type AS targetType, target_id AS targetId FROM reports WHERE id = ? AND status = 'open'").get(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Open report not found.' });
  if (report.targetType === 'user') {
    const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(report.targetId);
    if (target && (target.id === req.session.userId || adminEmails.has(target.email.toLowerCase()))) {
      return res.status(403).json({ error: 'Moderator accounts cannot be deleted through a member report.' });
    }
  }
  const deletes = {
    user: 'DELETE FROM users WHERE id = ?',
    course: 'DELETE FROM courses WHERE id = ?',
    discussion: 'DELETE FROM community_discussions WHERE id = ?',
    comment: 'DELETE FROM discussion_comments WHERE id = ?',
    group_message: 'DELETE FROM community_messages WHERE id = ?',
    direct_message: 'DELETE FROM direct_messages WHERE id = ?',
  };
  const removed = db.prepare(deletes[report.targetType]).run(report.targetId);
  db.prepare("UPDATE reports SET status = 'reviewed' WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true, removed: Boolean(removed.changes) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(port, () => console.log(`SkillBridge is running at http://localhost:${port}`));
