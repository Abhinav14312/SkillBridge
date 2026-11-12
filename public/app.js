const state = {
  user: null,
  skills: [],
  page: 'home',
  authMode: 'register',
  selectedCommunity: null,
  communityJoined: false,
  roomView: 'chat',
  chatAfter: 0,
  chatTimer: null,
  selectedContact: null,
  directAfter: 0,
  directTimer: null,
  editCourseId: null,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  let data = {};
  try { data = response.status === 204 ? {} : await response.json(); }
  catch { throw new Error('The app server did not return a valid response. Open SkillBridge at http://localhost:3000 and restart it if needed.'); }
  if (!response.ok) {
    if (response.status === 403 && data.error?.includes('account is unavailable')) {
      stopChatPolling();
      stopDirectPolling();
      state.user = null;
      state.skills = [];
      renderAuth();
    }
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('visible'), 2800);
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('#name-field').classList.toggle('hidden', mode !== 'register');
  $('#auth-form [name="name"]').required = mode === 'register';
  const password = $('#auth-form [name="password"]');
  password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  password.minLength = mode === 'register' ? 8 : 0;
  password.placeholder = mode === 'register' ? 'At least 8 characters' : 'Your password';
  $('#auth-submit').textContent = mode === 'register' ? 'Create my account' : 'Sign in';
  $('#auth-message').textContent = '';
}

function renderAuth() {
  $('#auth-panel').classList.toggle('hidden', Boolean(state.user));
  $('#app-panel').classList.toggle('hidden', !state.user);
  $('#account-area').innerHTML = state.user
    ? `<span class="account-name">${esc(state.user.name)}</span><button class="button soft" id="logout-button">Sign out</button>`
    : '';
  $('#moderation-nav').classList.toggle('hidden', !state.user?.isAdmin);
  $('#logout-button')?.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
      stopChatPolling();
      stopDirectPolling();
      state.user = null;
      state.skills = [];
      renderAuth();
    } catch (error) { toast(error.message); }
  });
}

async function reportItem(targetType, targetId) {
  const reason = window.prompt('Briefly tell the moderators what concerns you.');
  if (!reason) return;
  try {
    await api('/api/reports', { method: 'POST', body: JSON.stringify({ targetType, targetId, reason }) });
    toast('Report sent to the moderators.');
  } catch (error) { toast(error.message); }
}

async function editPrompt(label, currentValue) {
  const value = window.prompt(label, currentValue);
  return value === null ? null : value.trim();
}

function showAuthErrorFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');
  if (authError === 'account_unavailable') {
    $('#auth-message').textContent = 'This account is unavailable. Contact SkillBridge support.';
  }
  if (authError === 'google_not_configured') {
    $('#auth-message').textContent = 'Google sign-in is not configured yet. Use email and password, or add the Google OAuth settings.';
  } else if (authError === 'google_failed') {
    $('#auth-message').textContent = 'Google sign-in did not complete. Please try again or use email and password.';
  } else if (params.get('signedIn') === 'google') {
    toast('Signed in with Google. Welcome!');
  }
  if (authError || params.has('signedIn')) window.history.replaceState({}, '', window.location.pathname);
}

function skillList(kind) {
  return state.skills.filter((skill) => skill.kind === kind).map((skill) => skill.name);
}

function chips(items, type = '') {
  return items.length
    ? `<div class="chips">${items.map((name) => `<span class="chip ${type}">${esc(name)}</span>`).join('')}</div>`
    : '<span class="empty-hint">Nothing added yet</span>';
}

const heroPersonas = {
  spark: { title: 'The Spark', image: '/assets/heroes/spark.svg' },
  guardian: { title: 'The Guardian', image: '/assets/heroes/guardian.svg' },
  inventor: { title: 'The Maker', image: '/assets/heroes/inventor.svg' },
  voyager: { title: 'The Voyager', image: '/assets/heroes/voyager.svg' },
  oracle: { title: 'The Oracle', image: '/assets/heroes/oracle.svg' },
};

function heroAvatar(name, persona = 'spark', sizeClass = 'avatar') {
  const selected = heroPersonas[persona] ? persona : 'spark';
  return `<span class="hero-avatar ${sizeClass} persona-${selected}" role="img" aria-label="${esc(name)} — ${heroPersonas[selected].title}"><img src="${heroPersonas[selected].image}" alt=""></span>`;
}

function renderProfile() {
  const teach = skillList('teach');
  const learn = skillList('learn');
  $('#welcome-name').textContent = `Welcome, ${state.user.name}.`;
  $('#profile-summary').innerHTML = `
    <p class="eyebrow">YOUR SKILLBRIDGE PROFILE</p>
    <div class="profile-name-row">${heroAvatar(state.user.name, state.user.heroPersona, 'profile-avatar')}<div><h2>${esc(state.user.name)}</h2><span class="hero-title">${heroPersonas[state.user.heroPersona]?.title || heroPersonas.spark.title}</span><span class="profile-email">${esc(state.user.email)}</span></div></div>
    <p class="profile-bio">${esc(state.user.bio || 'Add an introduction so people know what brings you to SkillBridge.')}</p>
    <p class="skill-label">Skills I can teach</p>${chips(teach)}
    <p class="skill-label">Skills I want to learn</p>${chips(learn, 'learn')}
    <button class="button soft profile-edit-inline" id="profile-edit-inline">Edit profile</button>`;
  $('#profile-form [name="name"]').value = state.user.name;
  $('#profile-form [name="heroPersona"]').value = state.user.heroPersona || 'spark';
  $('#profile-form [name="bio"]').value = state.user.bio || '';
  $('#profile-form [name="teach"]').value = teach.join(', ');
  $('#profile-form [name="learn"]').value = learn.join(', ');
  $('#profile-edit-inline').addEventListener('click', () => $('#profile-dialog').showModal());
}

async function loadMembers() {
  const { members } = await api('/api/members');
  $('#member-list').innerHTML = members.length ? members.map((member) => {
    const teaches = member.teach.length ? `<p class="skill-label">Can teach</p>${chips(member.teach)}` : '';
    const learns = member.learn.length ? `<p class="skill-label">Wants to learn</p>${chips(member.learn, 'learn')}` : '';
    const relationship = member.connectionStatus === 'accepted'
      ? `<button class="button soft message-member" data-id="${member.id}">Message</button><span class="joined-label">Connected</span>`
      : member.connectionStatus === 'outgoing'
        ? '<button class="button soft" disabled>Request pending</button>'
        : member.connectionStatus === 'incoming'
          ? `<button class="button primary accept-member" data-id="${member.incomingRequestId}">Accept request</button>`
          : `<button class="button soft connect-button" data-id="${member.id}">Send connection request</button>`;
    return `<article class="card member-card">${heroAvatar(member.name, member.heroPersona)}<h3>${esc(member.name)}</h3><span class="hero-title">${heroPersonas[member.heroPersona]?.title || heroPersonas.spark.title}</span><p>${esc(member.bio || 'A SkillBridge learner.')}</p>${teaches}${learns}<div class="member-relationship">${relationship}</div><button class="text-button report-member" data-id="${member.id}">Report member</button></article>`;
  }).join('') : '<article class="card empty-state"><h3>No other members yet</h3><p>When people join SkillBridge, you will find them here.</p></article>';
  document.querySelectorAll('.connect-button').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/connections/${button.dataset.id}`, { method: 'POST' });
      await Promise.all([loadMembers(), loadConnections()]);
      toast('Connection request sent.');
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll('.accept-member').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/connections/requests/${button.dataset.id}/respond`, { method: 'POST', body: JSON.stringify({ action: 'accept' }) });
      await Promise.all([loadMembers(), loadConnections()]);
      toast('Connection accepted. You can message each other now.');
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll('.message-member').forEach((button) => button.addEventListener('click', async () => {
    showPage('messages');
    await loadConnections();
    const { accepted } = await api('/api/connections');
    const contact = accepted.find((item) => String(item.userId) === button.dataset.id);
    if (contact) await selectContact(contact);
  }));
  document.querySelectorAll('.report-member').forEach((button) => button.addEventListener('click', () => reportItem('user', button.dataset.id)));
}

function stopDirectPolling() {
  if (state.directTimer) clearInterval(state.directTimer);
  state.directTimer = null;
}

async function loadConnections() {
  const { incoming, outgoing, accepted } = await api('/api/connections');
  $('#request-list').innerHTML = incoming.length
    ? incoming.map((item) => `<article class="request-item">${heroAvatar(item.name, item.heroPersona, 'request-avatar')}<div><strong>${esc(item.name)}</strong><span class="hero-title">${heroPersonas[item.heroPersona]?.title || heroPersonas.spark.title}</span></div><p>${esc(item.bio || 'Wants to connect with you.')}</p><div><button class="button primary request-response" data-id="${item.requestId}" data-action="accept">Accept</button><button class="button soft request-response" data-id="${item.requestId}" data-action="decline">Decline</button></div></article>`).join('')
    : '<p class="empty-hint">No incoming requests.</p>';
  if (outgoing.length) {
    $('#request-list').insertAdjacentHTML('beforeend', `<div class="outgoing-requests"><p class="eyebrow">SENT REQUESTS</p>${outgoing.map((item) => `<p>${esc(item.name)} <span>· Pending</span></p>`).join('')}</div>`);
  }
  $('#contact-list').innerHTML = accepted.length
    ? accepted.map((contact) => `<button class="contact-item ${state.selectedContact?.userId === contact.userId ? 'active' : ''}" data-id="${contact.userId}">${heroAvatar(contact.name, contact.heroPersona)}<span>${esc(contact.name)}<small>${heroPersonas[contact.heroPersona]?.title || heroPersonas.spark.title}</small></span></button>`).join('')
    : '<p class="empty-hint">Accepted connections appear here.</p>';
  document.querySelectorAll('.request-response').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/connections/requests/${button.dataset.id}/respond`, { method: 'POST', body: JSON.stringify({ action: button.dataset.action }) });
      await Promise.all([loadConnections(), loadMembers()]);
      toast(button.dataset.action === 'accept' ? 'Connection accepted.' : 'Request declined.');
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll('.contact-item').forEach((button) => button.addEventListener('click', () => selectContact(accepted.find((contact) => String(contact.userId) === button.dataset.id))));
}

function renderDirectMessages(messages, replace = false) {
  const list = $('#direct-messages');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  if (replace) list.innerHTML = '';
  const html = messages.map((message) => {
    const own = message.senderId === state.user.id;
    const author = own ? 'You' : state.selectedContact.name;
    return `<article class="chat-message ${own ? 'own-message' : ''}">${heroAvatar(author, own ? state.user.heroPersona : message.senderPersona, 'chat-avatar')}<div class="chat-bubble"><strong>${esc(author)}</strong><p>${esc(message.body)}</p><time>${new Date(`${message.createdAt}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>${own ? `<button class="message-delete direct-edit" data-id="${message.id}" data-body="${esc(message.body)}">Edit</button><button class="message-delete direct-delete" data-id="${message.id}" aria-label="Delete message">Delete</button>` : `<button class="message-delete direct-report" data-id="${message.id}">Report</button>`}</div></article>`;
  }).join('');
  if (replace) list.innerHTML = html || '<p class="empty-hint chat-empty">No messages yet. Say hello.</p>';
  else if (html) { list.querySelector('.chat-empty')?.remove(); list.insertAdjacentHTML('beforeend', html); }
  if (messages.length) state.directAfter = Math.max(state.directAfter, ...messages.map((message) => message.id));
  if (replace || nearBottom) list.scrollTop = list.scrollHeight;
}

async function loadDirectMessages(replace = false) {
  if (!state.selectedContact) return;
  const after = replace ? 0 : state.directAfter;
  const { messages } = await api(`/api/direct-messages/${state.selectedContact.userId}?after=${after}`);
  renderDirectMessages(messages, replace);
}

async function selectContact(contact) {
  if (!contact) return;
  stopDirectPolling();
  state.selectedContact = contact;
  state.directAfter = 0;
  $('#direct-empty').classList.add('hidden');
  const panel = $('#direct-conversation');
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="direct-heading">${heroAvatar(contact.name, contact.heroPersona, 'direct-avatar')}<div><strong>${esc(contact.name)}</strong><small>${heroPersonas[contact.heroPersona]?.title || heroPersonas.spark.title} · connected</small></div></div><div id="direct-messages" class="chat-messages"></div><form id="direct-form" class="chat-form"><input name="body" maxlength="2000" placeholder="Send a message…" autocomplete="off" required><button class="button primary" type="submit">Send</button></form>`;
  $('#direct-messages').addEventListener('click', async (event) => {
    const button = event.target.closest('.direct-edit, .direct-delete, .direct-report');
    if (!button) return;
    if (button.classList.contains('direct-report')) return reportItem('direct_message', button.dataset.id);
    if (button.classList.contains('direct-edit')) {
      const body = await editPrompt('Edit your message', button.dataset.body);
      if (body === null) return;
      try { await api(`/api/direct-messages/${button.dataset.id}`, { method: 'PUT', body: JSON.stringify({ body }) }); await loadDirectMessages(true); }
      catch (error) { toast(error.message); }
      return;
    }
    try { await api(`/api/direct-messages/${button.dataset.id}`, { method: 'DELETE' }); await loadDirectMessages(true); }
    catch (error) { toast(error.message); }
  });
  $('#direct-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form).get('body');
    try { await api(`/api/direct-messages/${contact.userId}`, { method: 'POST', body: JSON.stringify({ body }) }); form.reset(); await loadDirectMessages(); }
    catch (error) { toast(error.message); }
  });
  try {
    await loadDirectMessages(true);
    state.directTimer = setInterval(() => loadDirectMessages().catch((error) => console.warn(error.message)), 2500);
  } catch (error) { toast(error.message); }
  await loadConnections();
}

async function loadModerationReports() {
  const { reports } = await api('/api/moderation/reports');
  $('#moderation-list').innerHTML = reports.length ? reports.map((report) => `
    <article class="card report-card"><div><p class="eyebrow">${esc(report.targetType.replace('_', ' '))} · #${report.targetId}</p><h3>Reported by ${esc(report.reporterName)}</h3><p>${esc(report.reason)}</p><span class="report-status">${esc(report.status)}</span></div><div class="moderation-actions">${report.targetType === 'user' ? `<button class="button ${report.targetSuspended ? 'soft' : 'danger'} toggle-suspension" data-user-id="${report.targetId}" data-suspended="${report.targetSuspended ? 'true' : 'false'}">${report.targetSuspended ? 'Restore account' : 'Suspend account'}</button>` : ''}<button class="button soft dismiss-report" data-id="${report.id}">Dismiss</button><button class="button soft review-report" data-id="${report.id}">Mark reviewed</button><button class="button danger remove-reported" data-id="${report.id}" data-target-type="${report.targetType}">${report.targetType === 'user' ? 'Delete account' : 'Remove content'}</button></div></article>`).join('')
    : '<article class="card empty-state"><h3>No reports</h3><p>There are no reports to review.</p></article>';
  document.querySelectorAll('.dismiss-report,.review-report').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/moderation/reports/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: button.classList.contains('dismiss-report') ? 'dismissed' : 'reviewed' }) });
      await loadModerationReports();
    } catch (error) { toast(error.message); }
  }));
  document.querySelectorAll('.remove-reported').forEach((button) => button.addEventListener('click', async () => {
    const deletingAccount = button.dataset.targetType === 'user';
    if (!window.confirm(deletingAccount ? 'Permanently delete this member account and their content?' : 'Remove the reported content?')) return;
    try { await api(`/api/moderation/reports/${button.dataset.id}/content`, { method: 'DELETE' }); await loadModerationReports(); toast('Reported content removed.'); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll('.toggle-suspension').forEach((button) => button.addEventListener('click', async () => {
    const suspended = button.dataset.suspended !== 'true';
    if (!window.confirm(suspended ? 'Suspend this member? They will be signed out and unable to sign in.' : 'Restore this member’s access?')) return;
    try {
      await api(`/api/moderation/users/${button.dataset.userId}/suspension`, { method: 'PATCH', body: JSON.stringify({ suspended }) });
      await loadModerationReports();
      toast(suspended ? 'Account suspended.' : 'Account access restored.');
    } catch (error) { toast(error.message); }
  }));
}

async function loadCommunities() {
  const { communities } = await api('/api/communities');
  $('#community-list').innerHTML = communities.length ? communities.map((community) => `
    <article class="card community-card">
      <div class="community-card-top"><div class="community-symbol">${esc(community.name.slice(0, 1).toUpperCase())}</div><span class="team-badge">✦ TEAM</span></div>
      <div class="community-count">${community.memberCount} ${community.memberCount === 1 ? 'member' : 'members'}</div>
      <h3>${esc(community.name)}</h3><p>${esc(community.description)}</p>
      <div class="community-actions"><button class="button soft open-community" data-id="${community.id}">View community</button><span class="joined-label">${community.joined ? 'Joined' : 'Open to join'}</span></div>
    </article>`).join('') : '<article class="card empty-state"><h3>No communities yet</h3><p>Create the first group for a topic you want to learn or teach.</p></article>';
  document.querySelectorAll('.open-community').forEach((button) => button.addEventListener('click', () => selectCommunity(button.dataset.id)));
}

function showCommunityDirectory(show) {
  $('#community-list').classList.toggle('hidden', !show);
  $('#community-form').classList.toggle('hidden', !show);
  $('#selected-community').classList.toggle('hidden', show);
}

function stopChatPolling() {
  if (state.chatTimer) clearInterval(state.chatTimer);
  state.chatTimer = null;
}

function renderMessages(messages, replace = false) {
  const list = $('#chat-messages');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  if (replace) list.innerHTML = '';
  const content = messages.map((message) => `<article class="chat-message ${message.userId === state.user.id ? 'own-message' : ''}">${heroAvatar(message.name, message.heroPersona, 'chat-avatar')}<div class="chat-bubble"><strong>${esc(message.name)}</strong><p>${esc(message.body)}</p><time>${new Date(`${message.createdAt}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>${message.userId === state.user.id ? `<button class="message-delete group-edit" data-id="${message.id}" data-body="${esc(message.body)}">Edit</button><button class="message-delete group-delete" data-id="${message.id}">Delete</button>` : `<button class="message-delete group-report" data-id="${message.id}">Report</button>`}</div></article>`).join('');
  if (replace) list.innerHTML = content || '<p class="empty-hint chat-empty">No messages yet. Say hello to the group.</p>';
  else if (content) {
    list.querySelector('.chat-empty')?.remove();
    list.insertAdjacentHTML('beforeend', content);
  }
  if (messages.length) state.chatAfter = Math.max(state.chatAfter, ...messages.map((message) => message.id));
  if (replace || nearBottom) list.scrollTop = list.scrollHeight;
}

async function loadChatMessages(replace = false) {
  if (!state.selectedCommunity) return;
  const after = replace ? 0 : state.chatAfter;
  const { messages } = await api(`/api/communities/${state.selectedCommunity}/messages?after=${after}`);
  renderMessages(messages, replace);
}

function renderDiscussions(discussions) {
  const list = $('#discussion-list');
  list.innerHTML = discussions.length ? discussions.map((discussion) => `
    <article class="card discussion-card">
      <div class="discussion-byline">${heroAvatar(discussion.name, discussion.heroPersona, 'post-avatar')}<strong>${esc(discussion.name)}</strong><span>${discussion.commentCount} ${discussion.commentCount === 1 ? 'reply' : 'replies'}</span></div>
      <h3>${esc(discussion.title)}</h3><p class="discussion-body">${esc(discussion.body)}</p>
      <div class="discussion-actions">${discussion.userId === state.user.id ? `<button class="text-button edit-discussion" data-id="${discussion.id}" data-title="${esc(discussion.title)}" data-body="${esc(discussion.body)}">Edit</button><button class="text-button delete-discussion" data-id="${discussion.id}">Delete</button>` : `<button class="text-button report-discussion" data-id="${discussion.id}">Report discussion</button>`}</div>
      <div class="comment-list">${discussion.comments.map((comment) => `<div class="comment">${heroAvatar(comment.name, comment.heroPersona, 'post-avatar')}<div><strong>${esc(comment.name)}</strong><p>${esc(comment.body)}</p>${comment.userId === state.user.id ? `<button class="text-button edit-comment" data-id="${comment.id}" data-discussion-id="${discussion.id}" data-body="${esc(comment.body)}">Edit</button><button class="text-button delete-comment" data-id="${comment.id}" data-discussion-id="${discussion.id}">Delete</button>` : `<button class="text-button report-comment" data-id="${comment.id}">Report reply</button>`}</div></div>`).join('')}</div>
      ${state.communityJoined ? `<form class="comment-form" data-discussion-id="${discussion.id}"><input name="body" maxlength="1500" placeholder="Write a reply…" required><button class="button soft" type="submit">Reply</button></form>` : ''}
    </article>`).join('') : '<article class="card empty-state"><h3>No discussions yet</h3><p>Start a topic and learn from what the group has to say.</p></article>';
  document.querySelectorAll('.comment-form').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = new FormData(form).get('body');
    try {
      await api(`/api/discussions/${form.dataset.discussionId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      await loadCommunityRoom(state.selectedCommunity);
    } catch (error) { toast(error.message); }
  }));
  list.querySelectorAll('.delete-discussion').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this discussion and its replies?')) return;
    try { await api(`/api/discussions/${button.dataset.id}`, { method: 'DELETE' }); await loadCommunityRoom(state.selectedCommunity); }
    catch (error) { toast(error.message); }
  }));
  list.querySelectorAll('.delete-comment').forEach((button) => button.addEventListener('click', async () => {
    try { await api(`/api/discussions/${button.dataset.discussionId}/comments/${button.dataset.id}`, { method: 'DELETE' }); await loadCommunityRoom(state.selectedCommunity); }
    catch (error) { toast(error.message); }
  }));
  list.querySelectorAll('.edit-discussion').forEach((button) => button.addEventListener('click', async () => {
    const title = await editPrompt('Edit discussion title', button.dataset.title);
    if (title === null) return;
    const body = await editPrompt('Edit discussion text', button.dataset.body);
    if (body === null) return;
    try { await api(`/api/discussions/${button.dataset.id}`, { method: 'PUT', body: JSON.stringify({ title, body }) }); await loadCommunityRoom(state.selectedCommunity); }
    catch (error) { toast(error.message); }
  }));
  list.querySelectorAll('.edit-comment').forEach((button) => button.addEventListener('click', async () => {
    const body = await editPrompt('Edit your reply', button.dataset.body);
    if (body === null) return;
    try { await api(`/api/discussions/${button.dataset.discussionId}/comments/${button.dataset.id}`, { method: 'PUT', body: JSON.stringify({ body }) }); await loadCommunityRoom(state.selectedCommunity); }
    catch (error) { toast(error.message); }
  }));
  list.querySelectorAll('.report-discussion').forEach((button) => button.addEventListener('click', () => reportItem('discussion', button.dataset.id)));
  list.querySelectorAll('.report-comment').forEach((button) => button.addEventListener('click', () => reportItem('comment', button.dataset.id)));
}

async function loadCommunityRoom(id) {
  const { community, discussions } = await api(`/api/communities/${id}/room`);
  state.communityJoined = community.joined;
  state.roomView = community.joined ? state.roomView : 'discussions';
  showCommunityDirectory(false);
  $('#selected-community').innerHTML = `
    <div class="community-detail-heading"><button class="text-button back-communities" type="button">← All communities</button><div class="community-room-title"><p class="eyebrow">COMMUNITY</p><h2>${esc(community.name)}</h2><p>${esc(community.description)}</p><span class="community-count">${community.joined ? 'You are a member' : 'Public community · join to participate'}</span></div>${community.joined ? '<button class="button soft" id="leave-community">Leave community</button>' : '<button class="button primary" id="join-room">Join community</button>'}</div>
    <div class="room-tabs"><button class="room-tab ${state.roomView === 'discussions' ? 'active' : ''}" data-room-view="discussions">Posts</button>${community.joined ? `<button class="room-tab ${state.roomView === 'chat' ? 'active' : ''}" data-room-view="chat">Group chat</button>` : ''}</div>
    <section id="chat-room" class="chat-room ${state.roomView === 'chat' && community.joined ? '' : 'hidden'}"><div class="chat-room-caption"><strong>${esc(community.name)} chat</strong><span>Messages for community members</span></div><div id="chat-messages" class="chat-messages"></div><form id="chat-form" class="chat-form"><input name="body" maxlength="1000" placeholder="Write a message…" autocomplete="off" required><button class="button primary" type="submit">Send</button></form></section>
    <section id="discussion-room" class="discussion-room ${state.roomView === 'discussions' ? '' : 'hidden'}">${community.joined ? '<form id="discussion-form" class="card discussion-create"><p class="eyebrow">START A POST</p><input name="title" maxlength="120" placeholder="Give your post a clear title" required><textarea name="body" maxlength="5000" rows="3" placeholder="Ask a question or share something useful with this community" required></textarea><button class="button primary" type="submit">Create post</button></form>' : '<div class="card join-community-prompt"><strong>Join the community to take part</strong><p>Members can start posts, reply, and use the group chat.</p><button class="button primary" id="join-from-posts">Join community</button></div>'}<div id="discussion-list" class="stack"></div></section>`;
  renderDiscussions(discussions);
  $('.back-communities').addEventListener('click', () => {
    stopChatPolling();
    state.selectedCommunity = null;
    showCommunityDirectory(true);
  });
  const joinCommunity = async () => {
    try {
      await api(`/api/communities/${id}/join`, { method: 'POST' });
      state.roomView = 'discussions';
      await loadCommunities();
      await loadCommunityRoom(id);
      toast('You joined the community.');
    } catch (error) { toast(error.message); }
  };
  $('#join-room')?.addEventListener('click', joinCommunity);
  $('#join-from-posts')?.addEventListener('click', joinCommunity);
  $('#leave-community')?.addEventListener('click', async () => {
    if (!window.confirm('Leave this community?')) return;
    try {
      await api(`/api/communities/${id}/membership`, { method: 'DELETE' });
      stopChatPolling();
      state.selectedCommunity = null;
      await loadCommunities();
      showCommunityDirectory(true);
      toast('You left the community.');
    } catch (error) { toast(error.message); }
  });
  $('#chat-messages').addEventListener('click', async (event) => {
    const button = event.target.closest('.group-edit, .group-delete, .group-report');
    if (!button) return;
    if (button.classList.contains('group-report')) return reportItem('group_message', button.dataset.id);
    if (button.classList.contains('group-edit')) {
      const body = await editPrompt('Edit your message', button.dataset.body);
      if (body === null) return;
      try { await api(`/api/communities/${id}/messages/${button.dataset.id}`, { method: 'PUT', body: JSON.stringify({ body }) }); await loadChatMessages(true); }
      catch (error) { toast(error.message); }
      return;
    }
    try { await api(`/api/communities/${id}/messages/${button.dataset.id}`, { method: 'DELETE' }); await loadChatMessages(true); }
    catch (error) { toast(error.message); }
  });
  document.querySelectorAll('.room-tab').forEach((button) => button.addEventListener('click', async () => {
    state.roomView = button.dataset.roomView;
    await loadCommunityRoom(id);
  }));
  $('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form).get('body');
    try {
      await api(`/api/communities/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
      form.reset();
      await loadChatMessages();
    } catch (error) { toast(error.message); }
  });
  $('#discussion-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api(`/api/communities/${id}/discussions`, { method: 'POST', body: JSON.stringify({ title: data.get('title'), body: data.get('body') }) });
      form.reset();
      state.roomView = 'discussions';
      await loadCommunityRoom(id);
    } catch (error) { toast(error.message); }
  });
  if (state.roomView === 'chat') {
    await loadChatMessages(true);
    stopChatPolling();
    state.chatTimer = setInterval(() => loadChatMessages().catch((error) => console.warn(error.message)), 2500);
  } else {
    stopChatPolling();
  }
}

async function selectCommunity(id) {
  stopChatPolling();
  state.selectedCommunity = Number(id);
  state.chatAfter = 0;
  state.roomView = 'discussions';
  try {
    await loadCommunityRoom(id);
  } catch (error) { toast(error.message); }
}

async function loadCourses() {
  const { courses } = await api('/api/courses');
  $('#course-list').innerHTML = courses.length ? courses.map((course) => `
    <article class="card course-card"><div class="course-top"><span class="category">${esc(course.category)}</span><span class="lesson-count">${course.premium ? 'Subscription' : `${course.lessonCount} ${course.lessonCount === 1 ? 'lesson' : 'lessons'}`}</span></div>
      <h3>${esc(course.title)}</h3><p>${esc(course.description)}</p><span class="instructor">Taught by ${esc(course.instructor)}${course.mine ? ' · You' : ''}</span>
      <button class="button soft view-course" data-id="${course.id}">${course.premium && !course.enrolled && !course.mine ? 'Preview course' : 'View lessons'}</button><button class="button ${course.enrolled ? 'soft' : 'primary'} enroll-course" data-id="${course.id}" ${course.enrolled || course.premium ? 'disabled' : ''}>${course.enrolled ? 'In My Learning' : course.premium ? 'Subscription access coming later' : 'Add to My Learning'}</button><div class="course-manage">${course.mine ? `<button class="text-button edit-course" data-id="${course.id}">Edit</button><button class="text-button delete-course" data-id="${course.id}">Delete</button>` : `<button class="text-button report-course" data-id="${course.id}">Report course</button>`}</div></article>`).join('')
    : '<article class="card empty-state course-empty"><h3>No courses yet</h3><p>When a member publishes a course, it will appear here. You can create the first one.</p></article>';
  document.querySelectorAll('.view-course').forEach((button) => button.addEventListener('click', () => loadCourseDetail(button.dataset.id)));
  document.querySelectorAll('.enroll-course:not(:disabled)').forEach((button) => button.addEventListener('click', () => enrollCourse(button.dataset.id)));
  document.querySelectorAll('.edit-course').forEach((button) => button.addEventListener('click', () => editCourse(button.dataset.id)));
  document.querySelectorAll('.delete-course').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this course and its lessons?')) return;
    try { await api(`/api/courses/${button.dataset.id}`, { method: 'DELETE' }); await Promise.all([loadCourses(), loadLearning()]); toast('Course deleted.'); }
    catch (error) { toast(error.message); }
  }));
  document.querySelectorAll('.report-course').forEach((button) => button.addEventListener('click', () => reportItem('course', button.dataset.id)));
}

async function enrollCourse(id) {
  try {
    await api(`/api/courses/${id}/enroll`, { method: 'POST' });
    await Promise.all([loadCourses(), loadLearning()]);
    toast('Course added to My Learning.');
  } catch (error) { toast(error.message); }
}

async function loadLearning() {
  const { courses } = await api('/api/learning');
  $('#learning-list').innerHTML = courses.length ? courses.map((course) => `
    <article class="card learning-card"><div class="course-top"><span class="category">MISSION ${String(course.id).padStart(2, '0')}</span><span class="lesson-count">${course.completedLessons}/${course.lessonCount} lessons</span></div><h3>${esc(course.title)}</h3><p>${esc(course.description)}</p><span class="instructor">Taught by ${esc(course.instructor)}</span><div class="progress-track"><span style="width:${course.progress}%"></span></div><div class="progress-label">${course.progress}% complete · ${course.completedLessons * 25} XP earned</div><button class="button soft learning-open" data-id="${course.id}">Continue mission</button></article>`).join('')
    : '<article class="card empty-state"><h3>Your learning list is empty</h3><p>Browse member-created courses and add one to begin.</p><button class="button soft" data-go="courses">Browse courses</button></article>';
  document.querySelectorAll('#learning-list [data-go="courses"]').forEach((button) => button.addEventListener('click', () => showPage('courses')));
  document.querySelectorAll('.learning-open').forEach((button) => button.addEventListener('click', () => loadCourseDetail(button.dataset.id)));
}

async function editCourse(id) {
  try {
    const { course, lessons, locked } = await api(`/api/courses/${id}`);
    state.editCourseId = Number(id);
    const form = $('#course-form');
    form.elements.title.value = course.title;
    form.elements.category.value = course.category;
    form.elements.description.value = course.description;
    const container = $('#lesson-fields');
    container.innerHTML = '';
    lessons.forEach((lesson, index) => {
      const node = document.createElement('div');
      node.className = 'lesson-input';
      node.innerHTML = `<div class="lesson-builder-heading"><p class="eyebrow">LESSON ${index + 1}</p>${index ? '<button class="text-button remove-lesson" type="button">Remove</button>' : ''}</div><label>Lesson title<input name="lessonTitle" maxlength="120" required></label><label>Lesson content<textarea name="lessonContent" maxlength="10000" rows="4" required></textarea></label>`;
      node.querySelector('[name="lessonTitle"]').value = lesson.title;
      node.querySelector('[name="lessonContent"]').value = lesson.content;
      node.querySelector('.remove-lesson')?.addEventListener('click', () => node.remove());
      container.append(node);
    });
    $('#course-form-heading').textContent = 'Edit course';
    $('#course-submit').textContent = 'Save changes';
    $('#cancel-course-edit').classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { toast(error.message); }
}

function resetCourseForm() {
  state.editCourseId = null;
  const form = $('#course-form');
  form.reset();
  const container = $('#lesson-fields');
  container.innerHTML = '<div class="lesson-input"><label>Lesson 1 title<input name="lessonTitle" maxlength="120" placeholder="First lesson" required></label><label>Lesson content<textarea name="lessonContent" maxlength="10000" rows="4" placeholder="Write the lesson for your learners…" required></textarea></label></div>';
  $('#course-form-heading').textContent = 'Add a course';
  $('#course-submit').textContent = 'Publish course';
  $('#cancel-course-edit').classList.add('hidden');
}

async function loadCourseDetail(id) {
  try {
    const { course, lessons } = await api(`/api/courses/${id}`);
    const detail = $('#course-detail');
    detail.classList.remove('hidden');
    detail.innerHTML = `<article class="card course-detail-card"><button class="text-button close-course" type="button">← Back to courses</button><p class="eyebrow">${esc(course.category)}</p><h2>${esc(course.title)}</h2><p>${esc(course.description)}</p><span class="instructor">Taught by ${esc(course.instructor)}</span>${locked ? '<div class="card premium-locked"><strong>Subscription course</strong><p>Lessons are reserved for members with subscription access. Payments are not enabled yet.</p></div>' : course.enrolled ? '<span class="joined-label learning-status">In My Learning</span>' : course.premium ? '' : `<button class="button primary detail-enroll" data-id="${course.id}">Add to My Learning</button>`}<div class="lesson-list">${locked ? '' : lessons.length ? lessons.map((lesson, index) => `<details class="lesson-card" ${index === 0 ? 'open' : ''}><summary><span>Lesson ${index + 1}: ${esc(lesson.title)}</span></summary><div class="lesson-content">${esc(lesson.content)}</div><button class="button soft complete-lesson" data-lesson-id="${lesson.id}" data-course-id="${course.id}" ${lesson.completed ? 'disabled' : ''}>${lesson.completed ? 'Completed' : 'Mark lesson complete'}</button></details>`).join('') : '<p class="empty-hint">The instructor has not added lessons yet.</p>'}</div></article>`;
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('.close-course', detail).addEventListener('click', () => { detail.classList.add('hidden'); detail.innerHTML = ''; });
    detail.querySelector('.detail-enroll')?.addEventListener('click', async () => { await enrollCourse(course.id); await loadCourseDetail(course.id); });
    detail.querySelectorAll('.complete-lesson').forEach((button) => button.addEventListener('click', async () => {
      try { await api(`/api/courses/${button.dataset.courseId}/lessons/${button.dataset.lessonId}/complete`, { method: 'POST' }); button.textContent = 'Mission cleared · +25 XP'; button.disabled = true; await loadLearning(); toast('Mission cleared! +25 XP'); }
      catch (error) { toast(error.message); }
    }));
  } catch (error) { toast(error.message); }
}

async function refreshApp() {
  renderAuth();
  if (!state.user) return;
  renderProfile();
  await Promise.all([loadMembers(), loadCourses(), loadCommunities(), loadConnections(), loadLearning()]);
  showPage(state.page);
}

function showPage(page) {
  const availablePages = new Set(['home', 'discover', 'courses', 'learning', 'groups', 'profile', 'messages', 'moderation']);
  if (!availablePages.has(page) || (page === 'moderation' && !state.user?.isAdmin)) page = 'home';
  state.page = page;
  $('#home-page').classList.toggle('hidden', page !== 'home');
  $('#discover-page').classList.toggle('hidden', page !== 'discover');
  $('#courses-page').classList.toggle('hidden', page !== 'courses');
  $('#learning-page').classList.toggle('hidden', page !== 'learning');
  $('#groups-page').classList.toggle('hidden', page !== 'groups');
  $('#profile-page').classList.toggle('hidden', page !== 'profile');
  $('#messages-page').classList.toggle('hidden', page !== 'messages');
  $('#moderation-page').classList.toggle('hidden', page !== 'moderation');
  const activePage = $(`#${page}-page`);
  if (activePage) {
    activePage.classList.remove('page-enter');
    requestAnimationFrame(() => activePage.classList.add('page-enter'));
  }
  if (page !== 'groups') stopChatPolling();
  else if (state.selectedCommunity && state.roomView === 'chat' && !state.chatTimer) {
    loadChatMessages().catch((error) => toast(error.message));
    state.chatTimer = setInterval(() => loadChatMessages().catch((error) => console.warn(error.message)), 2500);
  }
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const headings = {
    home: [`Welcome, ${state.user?.name || ''}.`, 'Teach something. Learn something. Find your people.'],
    discover: ['Find your learning people.', 'Meet members who want to share what they know.'],
    courses: ['Courses from members.', 'Explore member-created lessons or publish something you can teach.'],
    learning: ['My learning.', 'Pick up where you left off and see your lesson progress.'],
    groups: ['Communities.', 'Join a group to chat, ask questions, and learn together.'],
    profile: ['My profile.', 'Your skills and learning goals help members find each other.'],
    messages: ['Messages.', 'Private conversations with members you are connected to.'],
    moderation: ['Moderation.', 'Review reports from the SkillBridge community.'],
  };
  $('#page-title').textContent = headings[page][0];
  $('#page-subtitle').textContent = headings[page][1];
  $('#profile-button').classList.toggle('hidden', page !== 'profile');
  if (page !== 'messages') stopDirectPolling();
  else if (state.selectedContact && !state.directTimer) {
    loadDirectMessages().catch((error) => toast(error.message));
    state.directTimer = setInterval(() => loadDirectMessages().catch((error) => console.warn(error.message)), 2500);
  }
}

document.querySelectorAll('.nav-link').forEach((button) => button.addEventListener('click', async () => {
  showPage(button.dataset.page);
  if (button.dataset.page === 'discover') await loadMembers();
  if (button.dataset.page === 'messages') await loadConnections();
  if (button.dataset.page === 'moderation') await loadModerationReports();
}));
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.go)));
document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.mode)));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const authForm = event.currentTarget;
  const data = new FormData(authForm);
  const payload = Object.fromEntries(data.entries());
  try {
    const result = await api(state.authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(payload) });
    state.user = result.user;
    state.skills = result.skills || [];
    authForm.reset();
    await refreshApp();
    toast(`Welcome${state.authMode === 'register' ? ' to SkillBridge' : ' back'}!`);
  } catch (error) { $('#auth-message').textContent = error.message; }
});

$('#profile-button').addEventListener('click', () => $('#profile-dialog').showModal());
$('#edit-profile-button').addEventListener('click', () => $('#profile-dialog').showModal());
$('#close-dialog').addEventListener('click', () => $('#profile-dialog').close());
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const split = (key) => String(data.get(key) || '').split(',').map((value) => value.trim()).filter(Boolean);
  try {
    const result = await api('/api/profile', { method: 'PUT', body: JSON.stringify({ name: data.get('name'), bio: data.get('bio'), heroPersona: data.get('heroPersona'), teach: split('teach'), learn: split('learn') }) });
    state.user = result.user;
    state.skills = result.skills;
    renderProfile();
    renderAuth();
    $('#profile-dialog').close();
    await loadMembers();
    toast('Profile saved.');
  } catch (error) { $('#profile-message').textContent = error.message; }
});

$('#community-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const result = await api('/api/communities', { method: 'POST', body: JSON.stringify({ name: data.get('name'), description: data.get('description') }) });
    form.reset();
    $('#community-message').textContent = '';
    await loadCommunities();
    await selectCommunity(result.id);
  } catch (error) { $('#community-message').textContent = error.message; }
});

$('#course-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const lessons = [...form.querySelectorAll('.lesson-input')].map((lesson) => ({
    title: $('input[name="lessonTitle"]', lesson).value,
    content: $('textarea[name="lessonContent"]', lesson).value,
  }));
  try {
    await api(state.editCourseId ? `/api/courses/${state.editCourseId}` : '/api/courses', { method: state.editCourseId ? 'PUT' : 'POST', body: JSON.stringify({ title: data.get('title'), category: data.get('category'), description: data.get('description'), lessons }) });
    const wasEditing = Boolean(state.editCourseId);
    resetCourseForm();
    $('#course-message').textContent = '';
    $('#course-detail').classList.add('hidden');
    await Promise.all([loadCourses(), loadLearning()]);
    toast(wasEditing ? 'Course updated.' : 'Your course is published.');
  } catch (error) { $('#course-message').textContent = error.message; }
});

$('#cancel-course-edit').addEventListener('click', resetCourseForm);

$('#add-lesson').addEventListener('click', () => {
  const container = $('#lesson-fields');
  if (container.children.length >= 30) return toast('A course can have up to 30 lessons.');
  const number = container.children.length + 1;
  const lesson = document.createElement('div');
  lesson.className = 'lesson-input';
  lesson.innerHTML = `<div class="lesson-builder-heading"><p class="eyebrow">LESSON ${number}</p><button class="text-button remove-lesson" type="button">Remove</button></div><label>Lesson title<input name="lessonTitle" maxlength="120" placeholder="Lesson ${number}" required></label><label>Lesson content<textarea name="lessonContent" maxlength="10000" rows="4" placeholder="Write the lesson for your learners…" required></textarea></label>`;
  $('.remove-lesson', lesson).addEventListener('click', () => lesson.remove());
  container.append(lesson);
});

(async function init() {
  setAuthMode('register');
  showAuthErrorFromUrl();
  try {
    const { googleEnabled } = await api('/api/auth-options');
    const googleButton = $('#google-signin');
    googleButton.classList.toggle('disabled', !googleEnabled);
    googleButton.setAttribute('aria-disabled', String(!googleEnabled));
    $('#google-help').textContent = googleEnabled
      ? 'Continue with your Google account.'
      : 'Google sign-in is unavailable until the app owner adds OAuth credentials.';
    if (!googleEnabled) googleButton.addEventListener('click', (event) => event.preventDefault());
    const result = await api('/api/me');
    state.user = result.user;
    state.skills = result.skills || [];
    renderAuth();
    if (state.user) await refreshApp();
  } catch (error) {
    $('#auth-panel').classList.remove('hidden');
    $('#app-panel').classList.add('hidden');
    $('#auth-message').textContent = error.message;
  }
})();
