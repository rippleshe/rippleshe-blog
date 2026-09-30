export {};

type Visitor = {
  id:string|number; email:string; username:string; nickname:string; greeting:string;
  created_at:string; last_seen_at:string; status:string; message_count:number;
};
type OwnerMessage = { id:string|number; body:string; created_at:string; deleted_at:string|null; email:string; username:string; nickname:string };
type OwnerStats = { visitors:number; messages:number };
type OwnerBackend = {
  kind:'local'|'edgeone';
  ready():Promise<boolean>;
  authenticate(email?:string, code?:string):Promise<{pending?:boolean;message?:string}>;
  logout():Promise<void>;
  visitors():Promise<{users:Visitor[];stats:OwnerStats}>;
  messages():Promise<{messages:OwnerMessage[]}>;
  removeUser(id:string|number):Promise<void>;
  removeMessage(id:string|number):Promise<void>;
};

const root = document.querySelector<HTMLElement>('#visitors-app');
if (!root) throw new Error('visitors root missing');
const provider = (root.dataset.provider || 'local') as OwnerBackend['kind'];
const apiBase = root.dataset.apiBase || '';

const keyInput = document.querySelector<HTMLInputElement>('#visitors-owner-key');
const emailInput = document.querySelector<HTMLInputElement>('#visitors-owner-email');
const codeField = document.querySelector<HTMLElement>('#visitors-owner-code-field');
const codeInput = document.querySelector<HTMLInputElement>('#visitors-owner-code');
const openButton = document.querySelector<HTMLButtonElement>('#visitors-open')!;
const logoutButton = document.querySelector<HTMLButtonElement>('#visitors-logout');
const keyStatus = document.querySelector<HTMLElement>('#visitors-key-status')!;
const dashboard = document.querySelector<HTMLElement>('#visitors-dashboard')!;
const tableBody = document.querySelector<HTMLTableSectionElement>('#visitors-table-body')!;
const messageList = document.querySelector<HTMLElement>('#owner-message-list')!;
const total = document.querySelector<HTMLElement>('#visitors-total')!;
const notes = document.querySelector<HTMLElement>('#visitors-notes')!;

let backend:OwnerBackend;
let ownerKey = provider === 'local' ? (sessionStorage.getItem('rippleshe-owner-key') || '') : '';
if (keyInput) keyInput.value = ownerKey;

function dateText(value:string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(value));
}

async function localApi<T>(path:string, options:RequestInit = {}):Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers:{ 'x-rippleshe-owner':ownerKey, 'content-type':'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '这页没有翻开。');
  return data as T;
}

function createLocalBackend():OwnerBackend {
  return {
    kind:'local',
    ready:async () => Boolean(ownerKey),
    authenticate:async () => {
      ownerKey = keyInput?.value.trim() || '';
      if (!ownerKey) throw new Error('先写下主人钥匙。');
      await localApi('/api/owner/visitors');
      sessionStorage.setItem('rippleshe-owner-key', ownerKey);
      return {};
    },
    logout:async () => {
      ownerKey = '';
      sessionStorage.removeItem('rippleshe-owner-key');
      if (keyInput) keyInput.value = '';
    },
    visitors:() => localApi('/api/owner/visitors'),
    messages:() => localApi('/api/owner/messages'),
    removeUser:async (id) => { await localApi(`/api/owner/users/${encodeURIComponent(String(id))}`, { method:'DELETE' }); },
    removeMessage:async (id) => { await localApi(`/api/owner/messages/${encodeURIComponent(String(id))}`, { method:'DELETE' }); },
  };
}

function createEdgeBackend():OwnerBackend {
  const edgeApi = async <T>(path:string, options:RequestInit = {}):Promise<T> => {
    const response = await fetch(`/api/guestbook${path}`, {
      credentials:'include',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    });
    const payload:any = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      const error:any = new Error(payload?.error || '这页没有翻开。');
      error.status = response.status;
      throw error;
    }
    return payload.data as T;
  };
  return {
    kind:'edgeone',
    ready:async () => {
      const state = await edgeApi<{authenticated:boolean;owner:boolean}>('/owner/status');
      if (!state.authenticated) return false;
      if (!state.owner) throw new Error('这页只给主人看。');
      return true;
    },
    authenticate:async (email, code) => {
      const address = String(email || '').trim().toLowerCase();
      if (!address) throw new Error('先写下主人邮箱。');
      const otp = String(code || '').trim();
      if (!otp) {
        await edgeApi('/auth/send', { method:'POST', body:JSON.stringify({ email:address, mode:'owner' }) });
        return { pending:true, message:'主人验证码已经寄出。把邮件里的 6 位数字写在这里。' };
      }
      await edgeApi('/auth/verify', { method:'POST', body:JSON.stringify({ code:otp }) });
      const state = await edgeApi<{authenticated:boolean;owner:boolean;uid?:string;email?:string}>('/owner/status');
      if (!state.owner) {
        const error:any = new Error('邮箱已经验证，但这个账号还没有主人权限。');
        error.uid = state.uid || '';
        error.email = state.email || address;
        throw error;
      }
      return {};
    },
    logout:async () => { await edgeApi('/logout', { method:'POST', body:'{}' }); },
    visitors:() => edgeApi('/owner/visitors'),
    messages:() => edgeApi('/owner/messages'),
    removeUser:async (id) => { await edgeApi('/owner/delete-user', { method:'POST', body:JSON.stringify({ uid:String(id) }) }); },
    removeMessage:async (id) => { await edgeApi('/owner/delete-message', { method:'POST', body:JSON.stringify({ id:Number(id) }) }); },
  };
}

function renderVisitors(users:Visitor[]) {
  tableBody.replaceChildren();
  users.forEach((user) => {
    const tr = document.createElement('tr');
    const cells = [
      `${user.nickname}\n@${user.username}`,
      user.email || '—',
      user.greeting || '—',
      dateText(user.created_at),
      dateText(user.last_seen_at),
      String(user.message_count),
    ];
    cells.forEach((value,index) => {
      const td = document.createElement('td');
      if (index === 0) {
        const [nickname,username] = value.split('\n');
        const b = document.createElement('b'); b.textContent = nickname;
        const small = document.createElement('small'); small.textContent = username;
        td.append(b,small);
      } else td.textContent = value;
      tr.append(td);
    });
    const action = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'visitor-remove'; remove.textContent = '移出';
    remove.addEventListener('click', async () => {
      if (!confirm(`把 ${user.nickname} 从来客簿里移出吗？他的留言也会一起收走。`)) return;
      try { await backend.removeUser(user.id); await loadDashboard(); }
      catch (error) { keyStatus.textContent = error instanceof Error ? error.message : '没有移出去。'; }
    });
    action.append(remove); tr.append(action); tableBody.append(tr);
  });
}

function renderMessages(messages:OwnerMessage[]) {
  messageList.replaceChildren();
  messages.forEach((message) => {
    const row = document.createElement('article'); row.className = 'owner-message';
    const no = document.createElement('span'); no.textContent = `#${String(message.id).slice(-6).toUpperCase()}`;
    const who = document.createElement('div');
    const b = document.createElement('b'); b.textContent = `${message.nickname} · @${message.username}`;
    const small = document.createElement('small'); small.textContent = `${message.email || '—'} · ${dateText(message.created_at)}`;
    who.append(b,small);
    const body = document.createElement('p'); body.textContent = message.body;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = message.deleted_at ? '已收起' : '从墙上收走'; button.disabled = Boolean(message.deleted_at);
    button.addEventListener('click', async () => {
      if (!confirm('把这一张从公开留言墙上收走吗？')) return;
      try { await backend.removeMessage(message.id); await loadDashboard(); }
      catch (error) { keyStatus.textContent = error instanceof Error ? error.message : '这张没有收起来。'; }
    });
    row.append(no,who,body,button); messageList.append(row);
  });
}

async function loadDashboard() {
  const [visitors,messages] = await Promise.all([backend.visitors(), backend.messages()]);
  total.textContent = String(visitors.stats.visitors).padStart(2,'0');
  notes.textContent = String(visitors.stats.messages).padStart(2,'0');
  renderVisitors(visitors.users);
  renderMessages(messages.messages);
  dashboard.hidden = false;
  keyStatus.textContent = '来客簿已经翻开。';
  if (logoutButton) logoutButton.hidden = false;
  if (emailInput) emailInput.disabled = true;
  openButton.hidden = backend.kind === 'edgeone';
  if (codeField) codeField.hidden = true;
  if (codeInput) { codeInput.disabled = true; codeInput.required = false; codeInput.value = ''; }
}

async function boot() {
  backend = provider === 'edgeone' ? createEdgeBackend() : createLocalBackend();
  const ready = await backend.ready();
  if (ready) {
    try { await loadDashboard(); }
    catch (error) {
      dashboard.hidden = true;
      keyStatus.textContent = error instanceof Error ? error.message : '这页只给主人看。';
    }
  } else if (backend.kind === 'edgeone') {
    keyStatus.textContent = '用主人邮箱收一枚 6 位验证码，再回来翻这一册。';
  }
}

openButton.addEventListener('click', async () => {
  const code = codeInput?.value.trim() || '';
  keyStatus.textContent = backend.kind === 'edgeone' ? (code ? '正在确认主人验证码……' : '正在寄主人验证码……') : '正在翻页……';
  try {
    const result = await backend.authenticate(emailInput?.value || '', code);
    if (result.pending) {
      keyStatus.textContent = result.message || '主人验证码已经寄出。';
      if (codeField) codeField.hidden = false;
      if (codeInput) { codeInput.disabled = false; codeInput.required = true; codeInput.focus(); }
      if (emailInput) emailInput.readOnly = true;
      openButton.textContent = '确认主人验证码';
      return;
    }
    await loadDashboard();
  } catch (error) {
    dashboard.hidden = true;
    const message = error instanceof Error ? error.message : '没有翻开。';
    keyStatus.textContent = message;
    if (backend.kind === 'edgeone' && /过期|重新获取|失效/.test(message)) {
      if (emailInput) { emailInput.readOnly = false; emailInput.disabled = false; }
      if (codeField) codeField.hidden = true;
      if (codeInput) { codeInput.disabled = true; codeInput.required = false; codeInput.value = ''; }
      openButton.hidden = false;
      openButton.textContent = '重新寄一枚主人验证码';
    }
  }
});

logoutButton?.addEventListener('click', async () => {
  await backend.logout().catch(() => null);
  dashboard.hidden = true;
  logoutButton.hidden = true;
  openButton.hidden = false;
  if (emailInput) { emailInput.disabled = false; emailInput.readOnly = false; emailInput.value = ''; }
  if (codeField) codeField.hidden = true;
  if (codeInput) { codeInput.disabled = true; codeInput.required = false; codeInput.value = ''; }
  openButton.textContent = backend.kind === 'edgeone' ? '寄一枚主人验证码' : '翻开来客簿';
  keyStatus.textContent = '来客簿已经合上。';
});

boot().catch((error) => {
  dashboard.hidden = true;
  keyStatus.textContent = error instanceof Error ? error.message : '这页没有翻开。';
});



