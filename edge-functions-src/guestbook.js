const ENV_ID = '__CLOUDBASE_ENV_ID__';
const PUBLISH_KEY = '__CLOUDBASE_PUBLISH_KEY__';
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
const ACCESS = 'rps_at';
const REFRESH = 'rps_rt';
const VERIFY_ID = 'rps_vid';
const VERIFY_EMAIL = 'rps_vemail';
const VERIFY_MODE = 'rps_vmode';
const VERIFY_EXISTING = 'rps_vexisting';

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookie(name) { return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
function verifyClears() { return [VERIFY_ID, VERIFY_EMAIL, VERIFY_MODE, VERIFY_EXISTING].map(clearCookie); }
function sessionClears() { return [ACCESS, REFRESH].map(clearCookie); }
function sessionCookies(access, refresh, expiresIn = 7200) {
  const out = [];
  if (access) out.push(setCookie(ACCESS, access, Math.max(60, Math.min(Number(expiresIn || 7200), 7200))));
  if (refresh) out.push(setCookie(REFRESH, refresh, 90 * 24 * 60 * 60));
  return out;
}

function json(payload, status = 200, cookies = []) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

async function cloud(path, { method = 'POST', token = PUBLISH_KEY, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(BASE + path, init);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: 'invalid_cloudbase_response', error_description: text.slice(0, 240) }; }
  return { ok: response.ok, status: response.status, data };
}

async function rpc(name, args = {}, token = PUBLISH_KEY) {
  return cloud(`/v1/rdb/rest/rpc/${encodeURIComponent(name)}`, { body: args, token });
}

function messageOf(data, fallback = '水面起了一点波纹，稍后再试。') {
  return data?.message || data?.error_description || data?.error || data?.code || fallback;
}
function rpcStatus(result) {
  const code = result?.code;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_AUTHENTICATED') return 401;
  if (code === 'REGISTRATION_CLOSED' || code === 'WRITING_CLOSED') return 403;
  if (code === 'USERNAME_TAKEN') return 409;
  if (code === 'RATE_LIMIT') return 429;
  return 400;
}
async function bodyJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16_384) throw new Error('请求太长了。');
  return request.json().catch(() => ({}));
}
function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}
function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}
function authToken(request) { return parseCookies(request)[ACCESS] || ''; }

async function refreshAccess(request) {
  const refresh = parseCookies(request)[REFRESH] || '';
  if (!refresh) return null;
  const result = await cloud('/auth/v1/token', {
    body: {
      client_id: ENV_ID,
      client_secret: '',
      grant_type: 'refresh_token',
      refresh_token: refresh,
    },
  });
  if (!result.ok || !result.data?.access_token) return null;
  return {
    token: String(result.data.access_token),
    cookies: sessionCookies(
      String(result.data.access_token),
      String(result.data.refresh_token || refresh),
      Number(result.data.expires_in || 7200),
    ),
  };
}

async function publicRpc(name, args = {}) {
  const result = await rpc(name, args);
  if (!result.ok) return json({ ok: false, error: messageOf(result.data) }, result.status || 502);
  const payload = result.data;
  if (!payload?.ok) return json({ ok: false, error: messageOf(payload) }, rpcStatus(payload));
  return json(payload);
}

async function userRpc(request, name, args = {}) {
  let token = authToken(request);
  let responseCookies = [];
  if (!token) {
    const refreshed = await refreshAccess(request);
    if (!refreshed) return json({ ok: false, error: '还没有认出你。' }, 401, sessionClears());
    token = refreshed.token;
    responseCookies = refreshed.cookies;
  }

  let result = await rpc(name, args, token);
  if (!result.ok && result.status === 401) {
    const refreshed = await refreshAccess(request);
    if (refreshed) {
      token = refreshed.token;
      responseCookies = refreshed.cookies;
      result = await rpc(name, args, token);
    }
  }
  if (!result.ok) {
    const cookies = result.status === 401 ? sessionClears() : responseCookies;
    return json({ ok: false, error: messageOf(result.data, '登录已经过期，请重新用邮箱回来。') }, result.status || 502, cookies);
  }
  const payload = result.data;
  if (!payload?.ok) return json({ ok: false, error: messageOf(payload) }, rpcStatus(payload), responseCookies);
  return json(payload, 200, responseCookies);
}

async function optionalUserRpc(request, name, args = {}, anonymousData = {}) {
  const cookies = parseCookies(request);
  if (!cookies[ACCESS] && !cookies[REFRESH]) return json({ ok:true, data:anonymousData });
  const response = await userRpc(request, name, args);
  if (response.status === 401) return json({ ok:true, data:anonymousData }, 200, sessionClears());
  return response;
}

async function sendCode(request) {
  if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
  const body = await bodyJson(request);
  const email = validEmail(body.email);
  const mode = ['register', 'owner'].includes(body.mode) ? body.mode : '';
  if (!email || !mode) return json({ ok: false, error: '邮箱或登录方式不正确。' }, 400);

  if (mode === 'register') {
    const gate = await rpc('rippleshe_guest_config_web');
    const open = gate.ok && gate.data?.ok && gate.data?.data?.registration_open === true;
    if (!open) return json({ ok: false, error: '来客登记还没有正式开放。' }, 403);
  }

  const target = mode === 'register' ? 'ANY' : 'USER';
  const result = await cloud('/auth/v1/verification', { body: { email, target } });
  if (!result.ok) return json({ ok: false, error: messageOf(result.data, '验证码没有寄出去。') }, result.status || 400);
  const id = String(result.data?.verification_id || '');
  if (!id) return json({ ok: false, error: '认证服务没有返回验证码凭据。' }, 502);
  const providerExpiresIn = Number(result.data?.expires_in || 600);
  const verificationMaxAge = Number.isFinite(providerExpiresIn)
    ? Math.max(60, Math.min(Math.floor(providerExpiresIn), 60 * 60))
    : 600;
  const cookies = [
    setCookie(VERIFY_ID, id, verificationMaxAge),
    setCookie(VERIFY_EMAIL, email, verificationMaxAge),
    setCookie(VERIFY_MODE, mode, verificationMaxAge),
    setCookie(VERIFY_EXISTING, result.data?.is_user ? '1' : '0', verificationMaxAge),
  ];
  return json({ ok: true, data: { pending: true, expires_in: verificationMaxAge } }, 200, cookies);
}

async function verifyCode(request) {
  if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
  const body = await bodyJson(request);
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: '请输入邮件里的 6 位验证码。' }, 400);
  const cookies = parseCookies(request);
  const verificationId = cookies[VERIFY_ID] || '';
  const email = cookies[VERIFY_EMAIL] || '';
  const mode = cookies[VERIFY_MODE] || '';
  const existed = cookies[VERIFY_EXISTING] === '1';
  if (!verificationId || !email || !mode) return json({ ok: false, error: '这封验证码已经过期，请重新获取。' }, 400, verifyClears());

  if (mode === 'register') {
    const password = String(body.password || '');
    if (password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return json({ ok: false, error: '密码请用 8–64 个字符，并至少包含字母和数字。' }, 400);
    }
    if (existed) {
      return json({ ok: false, error: '这个邮箱已经有账号了，直接用邮箱和密码登录就好。' }, 409, verifyClears());
    }
  }

  const verified = await cloud('/auth/v1/verification/verify', {
    body: { verification_id: verificationId, verification_code: code },
  });
  if (!verified.ok) return json({ ok: false, error: messageOf(verified.data, '验证码不正确。') }, verified.status || 400);
  const verificationToken = verified.data?.verification_token;
  if (!verificationToken) return json({ ok: false, error: '验证码验证完成，但没有获得登录凭据。' }, 502);

  let signed;
  if (mode === 'register') {
    signed = await cloud('/auth/v1/signup', {
      body: { email, verification_token: verificationToken, password: String(body.password || '') },
    });
  } else {
    signed = await cloud('/auth/v1/signin', { body: { verification_token: verificationToken } });
  }
  if (!signed.ok) return json({ ok: false, error: messageOf(signed.data, '这次没有登录成功。') }, signed.status || 400, verifyClears());
  const access = String(signed.data?.access_token || '');
  if (!access) return json({ ok: false, error: '认证完成，但没有获得访问凭据。' }, 502, verifyClears());
  const refresh = String(signed.data?.refresh_token || '');
  return json(
    { ok: true, data: { signed_in: true, mode } },
    200,
    [...sessionCookies(access, refresh, Number(signed.data?.expires_in || 7200)), ...verifyClears()],
  );
}

async function passwordLogin(request) {
  if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
  const body = await bodyJson(request);
  const email = validEmail(body.email);
  const password = String(body.password || '');
  if (!email || password.length < 8 || password.length > 64) {
    return json({ ok: false, error: '邮箱或密码没有写完整。' }, 400);
  }
  const signed = await cloud('/auth/v1/signin', { body: { username: email, password } });
  if (!signed.ok) {
    const raw = String(signed.data?.error || signed.data?.code || '');
    const message = raw === 'login_type_disabled'
      ? '密码登录暂时不可用。'
      : (raw === 'invalid_username_or_password' || raw === 'invalid_password' || raw === 'not_found')
        ? '邮箱或密码没有对上。'
        : messageOf(signed.data, '这次没有登录成功。');
    return json({ ok: false, error: message }, signed.status || 400, sessionClears());
  }
  const access = String(signed.data?.access_token || '');
  if (!access) return json({ ok: false, error: '登录完成，但没有获得访问凭据。' }, 502, sessionClears());
  const refresh = String(signed.data?.refresh_token || '');
  return json(
    { ok: true, data: { signed_in: true, mode: 'password' } },
    200,
    sessionCookies(access, refresh, Number(signed.data?.expires_in || 7200)),
  );
}

async function logout(request) {
  if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
  const token = authToken(request);
  if (token) await cloud('/auth/v1/revoke', { body: { token } }).catch(() => null);
  return json({ ok: true, data: { signed_out: true } }, 200, [...sessionClears(), ...verifyClears()]);
}

export default async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const marker = '/api/guestbook/';
  const route = url.pathname.includes(marker) ? url.pathname.split(marker)[1].replace(/\/+$/, '') : '';
  try {
    if (route === 'health' && request.method === 'GET') return json({ ok: true, service: 'rippleshe-edge-proxy', auth: 'email-password' });
    if (route === 'config' && request.method === 'GET') return publicRpc('rippleshe_guest_config_web');
    if (route === 'messages' && request.method === 'GET') return publicRpc('rippleshe_guest_public_state_web', { p_limit: 80 });
    if (route === 'me' && request.method === 'GET') return optionalUserRpc(request, 'rippleshe_guest_me_web', {}, { user:null });
    if (route === 'owner/status' && request.method === 'GET') return optionalUserRpc(request, 'rippleshe_guest_owner_status_web', {}, { authenticated:false, owner:false });
    if (route === 'auth/send' && request.method === 'POST') return sendCode(request);
    if (route === 'auth/verify' && request.method === 'POST') return verifyCode(request);
    if (route === 'auth/password' && request.method === 'POST') return passwordLogin(request);
    if (route === 'logout' && request.method === 'POST') return logout(request);
    if (route === 'profile' && request.method === 'POST') {
      if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
      const body = await bodyJson(request);
      return userRpc(request, 'rippleshe_guest_save_profile_web', {
        p_username: String(body.username || ''), p_nickname: String(body.nickname || ''), p_greeting: String(body.greeting || ''),
      });
    }
    if (route === 'post' && request.method === 'POST') {
      if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
      const body = await bodyJson(request);
      return userRpc(request, 'rippleshe_guest_post_message_web', { p_body: String(body.message || '') });
    }
    if (route === 'owner/visitors' && request.method === 'GET') return userRpc(request, 'rippleshe_guest_owner_visitors_web');
    if (route === 'owner/messages' && request.method === 'GET') return userRpc(request, 'rippleshe_guest_owner_messages_web');
    if (route === 'owner/delete-user' && request.method === 'POST') {
      if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
      const body = await bodyJson(request);
      return userRpc(request, 'rippleshe_guest_owner_delete_user_web', { p_uid: String(body.uid || '') });
    }
    if (route === 'owner/delete-message' && request.method === 'POST') {
      if (!requireSameOrigin(request)) return json({ ok: false, error: '来源校验失败。' }, 403);
      const body = await bodyJson(request);
      return userRpc(request, 'rippleshe_guest_owner_delete_message_web', { p_id: Number(body.id) });
    }
    return json({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : '水面起了一点波纹。' }, 500);
  }
}
