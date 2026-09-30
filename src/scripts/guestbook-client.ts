export {};

type GuestUser = { id:string|number; username:string; nickname:string; greeting:string };
type GuestMessage = { id:string|number; body:string; created_at:string; username:string; nickname:string; greeting:string };
type GuestConfig = { registration_open:boolean; writing_open:boolean; auth?:string };
type AuthFields = { email:string; username?:string; nickname?:string; greeting?:string; password?:string; code?:string };
type MeState = { user:GuestUser|null; needsProfile?:boolean; email?:string };
type AuthResult = { user?:GuestUser; pending?:boolean; message?:string; expiresIn?:number };

type GuestBackend = {
  kind:'local'|'edgeone'|'closed';
  config():Promise<GuestConfig>;
  me():Promise<MeState>;
  messages():Promise<{messages:GuestMessage[]; stats:{visitors:number;messages:number}}>;
  register(fields:AuthFields):Promise<AuthResult>;
  login(fields:AuthFields):Promise<AuthResult>;
  completeProfile(fields:AuthFields):Promise<GuestUser>;
  logout():Promise<void>;
  post(message:string):Promise<void>;
};

const root = document.querySelector<HTMLElement>('#guestbook-app');
if (!root) throw new Error('guestbook root missing');

const provider = (root.dataset.provider || 'closed') as GuestBackend['kind'];
const apiBase = root.dataset.apiBase || '';

const $ = <T extends Element>(selector:string) => document.querySelector<T>(selector);
const signedOut = $<HTMLElement>('#guestbook-signed-out')!;
const signedIn = $<HTMLElement>('#guestbook-signed-in')!;
const registerOpen = $<HTMLButtonElement>('#guestbook-register-open')!;
const loginOpen = $<HTMLButtonElement>('#guestbook-login-open')!;
const logoutButton = $<HTMLButtonElement>('#guestbook-logout')!;
const authDialog = $<HTMLDialogElement>('#guestbook-auth-dialog')!;
const authClose = $<HTMLButtonElement>('#guestbook-auth-close')!;
const tabRegister = $<HTMLButtonElement>('#guestbook-tab-register')!;
const tabLogin = $<HTMLButtonElement>('#guestbook-tab-login')!;
const registerForm = $<HTMLFormElement>('#guestbook-register-form')!;
const loginForm = $<HTMLFormElement>('#guestbook-login-form')!;
const registerStatus = $<HTMLElement>('#guestbook-register-status')!;
const loginStatus = $<HTMLElement>('#guestbook-login-status')!;
const messageForm = $<HTMLFormElement>('#guestbook-message-form')!;
const messageInput = $<HTMLTextAreaElement>('#guestbook-message')!;
const messageStatus = $<HTMLElement>('#guestbook-message-status')!;
const profileName = $<HTMLElement>('#guestbook-profile-name')!;
const profileGreeting = $<HTMLElement>('#guestbook-profile-greeting')!;
const avatar = $<HTMLElement>('#guestbook-avatar')!;
const sessionMark = $<HTMLElement>('#guestbook-session-mark')!;
const wall = $<HTMLElement>('#guestbook-wall')!;
const visitorCount = $<HTMLElement>('#guestbook-visitor-count')!;
const messageCount = $<HTMLElement>('#guestbook-message-count')!;
const heading = $<HTMLElement>('#guestbook-auth-heading');

let backend:GuestBackend;
let currentUser:GuestUser|null = null;
let guestbookConfig:GuestConfig = { registration_open:false, writing_open:false };
let profileSetupMode = false;

async function localApi<T>(path:string, options:RequestInit = {}):Promise<T> {
  return fetch(`${apiBase}${path}`, {
    credentials:'include',
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '水面起了一点波纹，稍后再试。');
    return data as T;
  });
}

function createLocalBackend():GuestBackend {
  return {
    kind:'local',
    config:() => localApi('/api/config', { headers:{} }),
    me:async () => ({ user:(await localApi<{user:GuestUser|null}>('/api/me', { headers:{} })).user }),
    messages:() => localApi('/api/messages?limit=80', { headers:{} }),
    register:async (fields) => ({ user:(await localApi<{user:GuestUser}>('/api/register', { method:'POST', body:JSON.stringify(fields) })).user }),
    login:async (fields) => ({ user:(await localApi<{user:GuestUser}>('/api/login', { method:'POST', body:JSON.stringify(fields) })).user }),
    completeProfile:async () => { throw new Error('本地模式不需要补来客签。'); },
    logout:async () => { await localApi('/api/logout', { method:'POST', body:'{}' }); },
    post:async (message) => { await localApi('/api/messages', { method:'POST', body:JSON.stringify({ message }) }); },
  };
}

function createClosedBackend():GuestBackend {
  return {
    kind:'closed',
    config:async () => ({ registration_open:false, writing_open:false, auth:'closed' }),
    me:async () => ({ user:null }),
    messages:async () => ({ messages:[], stats:{ visitors:0, messages:0 } }),
    register:async () => { throw new Error('来客登记还没有正式开放。'); },
    login:async () => { throw new Error('来客簿还没有正式开放。'); },
    completeProfile:async () => { throw new Error('来客登记还没有正式开放。'); },
    logout:async () => {},
    post:async () => { throw new Error('这一阶段先只读旧字，暂不开放落笔。'); },
  };
}

function createEdgeBackend():GuestBackend {
  const edgeApi = async <T>(path:string, options:RequestInit = {}):Promise<T> => {
    const response = await fetch(`/api/guestbook${path}`, {
      credentials:'include',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    });
    const payload:any = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      const error:any = new Error(payload?.error || '水面起了一点波纹，稍后再试。');
      error.status = response.status;
      throw error;
    }
    return payload.data as T;
  };
  const registerWithEmail = async (fields:AuthFields):Promise<AuthResult> => {
    const code = String(fields.code || '').trim();
    if (!code) {
      const pending = await edgeApi<{pending:boolean;expires_in?:number}>('/auth/send', {
        method:'POST', body:JSON.stringify({ email:fields.email, mode:'register' }),
      });
      const expiresIn = Number(pending?.expires_in || 0);
      const minutes = expiresIn > 0 ? Math.max(1, Math.ceil(expiresIn / 60)) : 0;
      return {
        pending:true,
        expiresIn,
        message:minutes
          ? `只需要这一次邮箱验证。验证码大约 ${minutes} 分钟内有效；注册完成后，以后直接邮箱 + 密码回来。`
          : '只需要这一次邮箱验证。注册完成后，以后直接邮箱 + 密码回来。',
      };
    }
    await edgeApi('/auth/verify', {
      method:'POST', body:JSON.stringify({ code, password:fields.password }),
    });
    const saved = await edgeApi<{user:GuestUser}>('/profile', {
      method:'POST',
      body:JSON.stringify({ username:fields.username, nickname:fields.nickname, greeting:fields.greeting }),
    });
    return { user:saved.user };
  };
  const loginWithPassword = async (fields:AuthFields):Promise<AuthResult> => {
    await edgeApi('/auth/password', {
      method:'POST', body:JSON.stringify({ email:fields.email, password:fields.password }),
    });
    const state = await edgeApi<MeState>('/me');
    if (!state.user) {
      if (state.needsProfile) throw new Error('账号已经登录，但来客签还没补完整。请从“第一次来”补完资料。');
      throw new Error('已经登录，但没有找到来客签。');
    }
    return { user:state.user };
  };
  return {
    kind:'edgeone',
    config:() => edgeApi('/config'),
    me:async () => {
      try { return await edgeApi<MeState>('/me'); }
      catch (error:any) { if (error?.status === 401) return { user:null }; throw error; }
    },
    messages:() => edgeApi('/messages'),
    register:(fields) => registerWithEmail(fields),
    login:(fields) => loginWithPassword(fields),
    completeProfile:async (fields) => (await edgeApi<{user:GuestUser}>('/profile', {
      method:'POST',
      body:JSON.stringify({ username:fields.username, nickname:fields.nickname, greeting:fields.greeting }),
    })).user,
    logout:async () => { await edgeApi('/logout', { method:'POST', body:'{}' }); },
    post:async (message) => { await edgeApi('/post', { method:'POST', body:JSON.stringify({ message }) }); },
  };
}

async function makeBackend():Promise<GuestBackend> {
  if (provider === 'local' && apiBase) return createLocalBackend();
  if (provider === 'edgeone') return createEdgeBackend();
  return createClosedBackend();
}

function formatDate(value:string) {
  return new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', year:'numeric' }).format(new Date(value));
}
function initials(name:string) {
  const chars = Array.from(name.trim());
  return (chars[0] || '客').toUpperCase();
}
function fieldsFrom(form:HTMLFormElement):AuthFields {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    email:String(data.email || ''),
    username:String(data.username || ''),
    nickname:String(data.nickname || ''),
    greeting:String(data.greeting || ''),
    password:String(data.password || ''),
    code:String(data.code || ''),
  };
}

function setCodeStage(form:HTMLFormElement, active:boolean) {
  const label = form.querySelector<HTMLElement>('[data-code-field]');
  const input = label?.querySelector<HTMLInputElement>('input[name="code"]');
  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (label) label.hidden = !active;
  if (input) { input.disabled = !active; input.required = active; if (!active) input.value = ''; }
  if (email) email.readOnly = active;
  if (button && backend.kind === 'edgeone') button.textContent = active ? '确认 6 位验证码' : '寄邮箱验证码';
  if (active) setTimeout(() => input?.focus(), 40);
}

function setAuthUi() {
  const edge = backend.kind === 'edgeone';
  for (const label of document.querySelectorAll<HTMLElement>('[data-password-field]')) {
    label.hidden = false;
    const input = label.querySelector<HTMLInputElement>('input');
    if (input) { input.required = true; input.disabled = false; }
  }
  if (edge) {
    setCodeStage(registerForm, false);
    const intro = signedOut.querySelector('p');
    const note = signedOut.querySelector('small');
    if (intro) intro.textContent = '第一次来时验证一次邮箱并设好密码；以后回来只用邮箱 + 密码，不再反复收验证码。';
    if (note) note.textContent = '邮箱只用于账号与主人来客簿，不会公开，也不会用于订阅或营销。';
  }
}

function setAuthMode(mode:'register'|'login') {
  const isRegister = mode === 'register';
  registerForm.hidden = !isRegister;
  loginForm.hidden = isRegister;
  tabRegister.classList.toggle('active', isRegister);
  tabLogin.classList.toggle('active', !isRegister);
  if (heading) heading.textContent = profileSetupMode ? '认下这张来客签' : (isRegister ? '来客登记' : '回来这一页');
  registerStatus.textContent = profileSetupMode ? '邮箱已经验证。再认一个门牌和昵称，这张来客签就完整了。' : '';
  loginStatus.textContent = '';
  tabLogin.hidden = profileSetupMode;
  tabRegister.textContent = profileSetupMode ? '补完来客签' : '第一次来';
  const registerEmail = registerForm.querySelector<HTMLInputElement>('input[name="email"]');
  const registerPassword = registerForm.querySelector<HTMLInputElement>('input[name="password"]');
  const registerPasswordLabel = registerPassword?.closest<HTMLElement>('[data-password-field]');
  if (registerEmail) {
    registerEmail.disabled = profileSetupMode;
    registerEmail.required = !profileSetupMode;
  }
  if (registerPassword) {
    registerPassword.disabled = profileSetupMode;
    registerPassword.required = !profileSetupMode;
  }
  if (registerPasswordLabel) registerPasswordLabel.hidden = profileSetupMode;
}
function openAuth(mode:'register'|'login') {
  setAuthMode(mode);
  if (!authDialog.open) authDialog.showModal();
  setTimeout(() => authDialog.querySelector<HTMLInputElement>('input:not([hidden]):not([disabled])')?.focus(), 40);
}
function renderSession() {
  const logged = Boolean(currentUser);
  signedOut.hidden = logged;
  signedIn.hidden = !logged;
  if (!currentUser) {
    sessionMark.textContent = backend?.kind === 'closed' ? 'GUESTBOOK / CLOSED' : 'GUEST / UNKNOWN';
    return;
  }
  profileName.textContent = `${currentUser.nickname} · @${currentUser.username}`;
  profileGreeting.textContent = currentUser.greeting || '今天也来水边坐一会儿。';
  avatar.textContent = initials(currentUser.nickname || currentUser.username);
  sessionMark.textContent = `VISITOR / ${String(currentUser.id).slice(0,8).toUpperCase()}`;
}

function createMessageCard(message:GuestMessage, index:number) {
  const article = document.createElement('article');
  article.className = `guest-note guest-note-${index % 5}`;
  const top = document.createElement('div');
  top.className = 'guest-note-top';
  const identity = document.createElement('div');
  identity.className = 'guest-note-identity';
  const mark = document.createElement('span');
  mark.className = 'guest-note-avatar';
  mark.textContent = initials(message.nickname || message.username);
  const names = document.createElement('div');
  const nickname = document.createElement('b'); nickname.textContent = message.nickname;
  const username = document.createElement('small'); username.textContent = `@${message.username}`;
  names.append(nickname, username); identity.append(mark, names);
  const indexLabel = document.createElement('span');
  indexLabel.className = 'guest-note-index';
  indexLabel.textContent = `NOTE / ${String(message.id).slice(-6).toUpperCase()}`;
  top.append(identity, indexLabel);
  const body = document.createElement('p'); body.className = 'guest-note-body'; body.textContent = message.body;
  const foot = document.createElement('div'); foot.className = 'guest-note-foot';
  const greeting = document.createElement('span'); greeting.textContent = message.greeting ? `“${message.greeting}”` : '来过，便有回声。';
  const time = document.createElement('time'); time.dateTime = message.created_at; time.textContent = formatDate(message.created_at);
  foot.append(greeting, time); article.append(top, body, foot);
  return article;
}

function renderMessages(messages:GuestMessage[]) {
  wall.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'guestbook-wall-empty guestbook-wall-awaiting';
    const lines = [['01','风还没有写字。'],['02','第一张笺仍是空白。'],['03','等一个名字落在这里。']];
    lines.forEach(([no,text], index) => {
      const slip = document.createElement('div'); slip.className = `guestbook-awaiting-slip guestbook-awaiting-slip-${index + 1}`;
      const mark = document.createElement('small'); mark.textContent = `BLANK / ${no}`;
      const p = document.createElement('p'); p.textContent = text;
      const rule = document.createElement('i'); slip.append(mark,p,rule); empty.append(slip);
    });
    const caption = document.createElement('span'); caption.className = 'guestbook-awaiting-caption'; caption.textContent = '留白也算水边的一部分。';
    empty.append(caption); wall.append(empty); return;
  }
  messages.forEach((message,index) => wall.append(createMessageCard(message,index)));
}

async function refreshWall() {
  try {
    const data = await backend.messages();
    renderMessages(data.messages);
    visitorCount.textContent = String(data.stats.visitors).padStart(2,'0');
    messageCount.textContent = String(data.stats.messages).padStart(2,'0');
  } catch {
    wall.innerHTML = '<div class="guestbook-wall-empty"><p>水面暂静。等风过去，再来读这一页。</p></div>';
  }
}

async function refreshMe() {
  try {
    const state = await backend.me();
    currentUser = state.user;
    profileSetupMode = Boolean(state.needsProfile);
    if (profileSetupMode) {
      const email = registerForm.querySelector<HTMLInputElement>('input[name="email"]');
      if (email) {
        email.value = state.email || '';
        email.disabled = true;
        email.required = false;
      }
      openAuth('register');
    }
  } catch {
    currentUser = null;
    profileSetupMode = false;
  }
  renderSession();
}

async function refreshConfig() {
  guestbookConfig = await backend.config().catch(() => ({ registration_open:false, writing_open:false }));
  registerOpen.disabled = !guestbookConfig.registration_open;
  loginOpen.disabled = backend.kind === 'closed';
  if (!guestbookConfig.registration_open && backend.kind !== 'closed') {
    registerOpen.title = '来客登记尚未开放';
    const intro = signedOut.querySelector('p');
    const note = signedOut.querySelector('small');
    if (intro) intro.textContent = '新的来客登记暂时没有开放；已经来过的人仍然可以直接用邮箱 + 密码回来看看。';
    if (note) note.textContent = '邮箱不会公开，也不会用于订阅或营销。';
  }
  messageInput.disabled = !guestbookConfig.writing_open;
  const writeButton = messageForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (writeButton) writeButton.disabled = !guestbookConfig.writing_open;
  if (!guestbookConfig.writing_open) messageStatus.textContent = '这一阶段先只读旧字，暂不开放落笔。';
}

function renderClosedState() {
  registerOpen.disabled = true;
  loginOpen.disabled = true;
  signedOut.innerHTML = '<p>来客登记还没有对外开放。这里先保留成一册可以看的水边留言墙，等邮箱验证和正式后端接好以后再开门。</p><small>PUBLIC GUESTBOOK / READ-ONLY UNTIL BACKEND IS READY</small>';
  sessionMark.textContent = 'GUESTBOOK / CLOSED';
  visitorCount.textContent = '—';
  messageCount.textContent = '—';
  wall.innerHTML = '<div class="guestbook-wall-empty guestbook-wall-awaiting"><div class="guestbook-awaiting-slip guestbook-awaiting-slip-1"><small>GATE / CLOSED</small><p>水边的门还没有正式打开。</p><i></i></div><span class="guestbook-awaiting-caption">等后端和邮箱验证都准备好，再让来客落笔。</span></div>';
}

registerOpen.addEventListener('click', () => { if (!registerOpen.disabled) openAuth('register'); });
loginOpen.addEventListener('click', () => { if (!loginOpen.disabled) openAuth('login'); });
tabRegister.addEventListener('click', () => setAuthMode('register'));
tabLogin.addEventListener('click', () => setAuthMode('login'));
authClose.addEventListener('click', () => authDialog.close());
authDialog.addEventListener('click', (event) => { if (event.target === authDialog) authDialog.close(); });

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = fieldsFrom(registerForm);
  registerStatus.textContent = profileSetupMode ? '正在认下这张来客签……' : (backend.kind === 'edgeone' ? (fields.code ? '正在确认邮箱验证码……' : '正在寄邮箱验证码……') : '正在把名字写进去……');
  try {
    if (profileSetupMode) {
      currentUser = await backend.completeProfile(fields);
      profileSetupMode = false;
      registerForm.reset();
      authDialog.close();
      renderSession();
      await refreshWall();
      messageInput.focus();
      return;
    }
    const result = await backend.register(fields);
    if (result.pending) {
      registerStatus.textContent = result.message || '验证码已经寄出。';
      if (backend.kind === 'edgeone') setCodeStage(registerForm, true);
      return;
    }
    if (result.user) {
      currentUser = result.user;
      registerForm.reset(); if (backend.kind === 'edgeone') setCodeStage(registerForm, false); authDialog.close(); renderSession(); await refreshWall(); messageInput.focus();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '这次没有写进去。';
    registerStatus.textContent = message;
    if (backend.kind === 'edgeone' && /过期|重新获取|失效/.test(message)) {
      setCodeStage(registerForm, false);
      const button = registerForm.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button) button.textContent = '重新寄邮箱验证码';
    }
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const loginFields = fieldsFrom(loginForm);
  loginStatus.textContent = '正在翻来客簿……';
  try {
    const result = await backend.login(loginFields);
    if (result.user) {
      currentUser = result.user;
      loginForm.reset(); authDialog.close(); renderSession(); messageInput.focus();
    }
  } catch (error) {
    loginStatus.textContent = error instanceof Error ? error.message : '这次没有认出来。';
  }
});

logoutButton.addEventListener('click', async () => {
  await backend.logout().catch(() => null);
  currentUser = null; profileSetupMode = false; renderSession();
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;
  const button = messageForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) button.disabled = true;
  messageStatus.textContent = '正在把这张笺放上去……';
  try {
    await backend.post(message);
    messageInput.value = '';
    messageStatus.textContent = '已经留在水边了。';
    await refreshWall();
  } catch (error) {
    messageStatus.textContent = error instanceof Error ? error.message : '这张笺没有放稳。';
  } finally {
    if (button) button.disabled = !guestbookConfig.writing_open;
  }
});

window.addEventListener('focus', () => { if (backend && backend.kind !== 'closed') void refreshConfig(); });

async function boot() {
  backend = await makeBackend();
  setAuthUi();
  if (backend.kind === 'closed') {
    renderClosedState();
    return;
  }
  await Promise.all([refreshConfig(), refreshMe(), refreshWall()]);
}

boot().catch(() => {
  backend = createClosedBackend();
  renderClosedState();
});



