export interface Env {
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  INSTAGRAM_APP_ID: string
  INSTAGRAM_APP_SECRET: string
  SESSION_SECRET: string
  WEB_ORIGIN: string
  APP_BASE_URL: string
  MEDIA_PUBLIC_BASE_URL: string
}

type JsonRecord = Record<string, unknown>

type SessionStatus = {
  authenticated: boolean
  setupRequired: boolean
}

type AccountRow = {
  id: string
  ig_user_id: string
  username: string
  access_token: string
  token_expires_at: string | null
  connected_at: string
}

type MediaAssetRow = {
  id: string
  r2_key: string
  filename: string
  mime_type: string
  media_url: string
  created_at: string
}

type ScheduledPostRow = {
  id: string
  caption: string
  media_asset_id: string
  scheduled_for: string
  status: string
  created_at: string
  updated_at: string
}

type TargetRow = {
  id: string
  scheduled_post_id: string
  account_id: string
  username: string
  status: string
  published_at: string | null
  error_message: string | null
}

const SESSION_COOKIE = 'ig_autopost_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx)
    } catch (error) {
      console.error(error)
      const status = error instanceof HttpError ? error.status : 500
      return json(
        {
          error: error instanceof Error ? error.message : 'Internal error',
        },
        status,
        env,
      )
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduler(env))
  },
} satisfies ExportedHandler<Env>

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }), env)
  }

  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, now: isoNow() }, 200, env)
  }

  if (path === '/api/session' && method === 'GET') {
    const session = await getSessionStatus(request, env)
    return json(session, 200, env)
  }

  if (path === '/api/dashboard' && method === 'GET') {
    const session = await getSessionStatus(request, env)
    if (!session.authenticated) {
      return json({ session, accounts: [], posts: [], logs: [] }, 200, env)
    }

    const [accounts, posts, logs] = await Promise.all([
      listAccounts(env),
      listPosts(env),
      listLogs(env),
    ])

    return json({ session, accounts, posts, logs }, 200, env)
  }

  if (path === '/api/setup' && method === 'POST') {
    const hasPassword = await appPasswordExists(env)
    if (hasPassword) throw new HttpError(400, 'Password already configured.')
    const body = await request.json<any>()
    const password = String(body.password || '').trim()
    validatePassword(password)
    const hash = await hashPassword(password, env)
    await env.DB.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).bind('password_hash', hash, isoNow()).run()
    return await createSessionResponse(env)
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await request.json<any>()
    const password = String(body.password || '').trim()
    const ok = await verifyPassword(password, env)
    if (!ok) throw new HttpError(401, 'Invalid password.')
    return await createSessionResponse(env)
  }

  if (path === '/api/logout' && method === 'POST') {
    await requireAuth(request, env)
    const sessionId = getCookie(request, SESSION_COOKIE)
    if (sessionId) {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run()
    }
    return cors(
      new Response(null, {
        status: 204,
        headers: {
          'Set-Cookie': expiredSessionCookie(env),
        },
      }),
      env,
    )
  }

  if (path === '/api/accounts' && method === 'GET') {
    await requireAuth(request, env)
    return json(await listAccounts(env), 200, env)
  }

  if (path === '/api/logs' && method === 'GET') {
    await requireAuth(request, env)
    return json(await listLogs(env), 200, env)
  }

  if (path === '/api/posts' && method === 'GET') {
    await requireAuth(request, env)
    return json(await listPosts(env), 200, env)
  }

  if (path === '/api/posts' && method === 'POST') {
    await requireAuth(request, env)
    const body = await request.json<any>()
    const caption = String(body.caption || '')
    const scheduledFor = String(body.scheduledFor || '')
    const mediaAssetId = String(body.mediaAssetId || '')
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds.map(String) : []

    if (!mediaAssetId) throw new HttpError(400, 'mediaAssetId required.')
    if (!scheduledFor) throw new HttpError(400, 'scheduledFor required.')
    if (!accountIds.length) throw new HttpError(400, 'At least one account required.')

    const scheduledDate = new Date(scheduledFor)
    if (Number.isNaN(scheduledDate.getTime())) throw new HttpError(400, 'Invalid scheduled time.')

    const mediaAsset = await env.DB.prepare(
      'SELECT id FROM media_assets WHERE id = ?'
    ).bind(mediaAssetId).first<{ id: string }>()
    if (!mediaAsset) throw new HttpError(404, 'Uploaded media not found.')

    const accountRows = await env.DB.prepare(
      `SELECT id FROM accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`
    ).bind(...accountIds).all<{ id: string }>()
    if ((accountRows.results || []).length !== accountIds.length) {
      throw new HttpError(400, 'One or more accounts are invalid.')
    }

    const postId = randomId()
    const now = isoNow()

    await env.DB.prepare(
      `INSERT INTO scheduled_posts (id, caption, media_asset_id, scheduled_for, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, ?)`
    ).bind(postId, caption, mediaAssetId, scheduledDate.toISOString(), now, now).run()

    for (const accountId of accountIds) {
      await env.DB.prepare(
        `INSERT INTO scheduled_post_accounts
           (id, scheduled_post_id, account_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`
      ).bind(randomId(), postId, accountId, now, now).run()
    }

    const created = await getPostById(env, postId)
    return json(created, 201, env)
  }

  if (path.startsWith('/api/posts/') && method === 'DELETE') {
    await requireAuth(request, env)
    const postId = path.split('/').pop()
    if (!postId) throw new HttpError(400, 'Missing post id.')
    await env.DB.prepare(
      `UPDATE scheduled_posts
       SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND status IN ('draft', 'scheduled')`
    ).bind(isoNow(), postId).run()
    await env.DB.prepare(
      `UPDATE scheduled_post_accounts
       SET status = 'cancelled', updated_at = ?
       WHERE scheduled_post_id = ? AND status = 'pending'`
    ).bind(isoNow(), postId).run()
    return cors(new Response(null, { status: 204 }), env)
  }

  if (path === '/api/upload' && method === 'POST') {
    await requireAuth(request, env)
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new HttpError(400, 'file is required.')
    if (!file.type.startsWith('image/')) throw new HttpError(400, 'Only image uploads are enabled in this first pass.')

    const mediaId = randomId()
    const extension = getExtension(file.name, file.type)
    const objectKey = `uploads/${mediaId}.${extension}`
    await env.MEDIA_BUCKET.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: file.type,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })

    const mediaUrl = `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}`
    const now = isoNow()

    await env.DB.prepare(
      `INSERT INTO media_assets (id, r2_key, filename, mime_type, media_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(mediaId, objectKey, file.name, file.type, mediaUrl, now).run()

    return json(
      {
        mediaAssetId: mediaId,
        mediaUrl,
        filename: file.name,
      },
      201,
      env,
    )
  }

  if (path === '/api/auth/instagram/start' && method === 'GET') {
    await requireAuth(request, env)
    const state = await makeSignedState(env, {
      nonce: randomId(),
      returnTo: `${env.WEB_ORIGIN.replace(/\/$/, '')}/`,
      issuedAt: Date.now(),
    })

    const params = new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      redirect_uri: `${env.APP_BASE_URL.replace(/\/$/, '')}/api/auth/instagram/callback`,
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish',
      state,
    })

    return Response.redirect(`https://www.instagram.com/oauth/authorize?${params.toString()}`, 302)
  }

  if (path === '/api/auth/instagram/callback' && method === 'GET') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (!code || !state) throw new HttpError(400, 'Missing code or state.')
    await parseSignedState(state, env)

    const token = await exchangeInstagramCode(code, env)
    const profile = await fetchInstagramProfile(token.access_token)

    const now = isoNow()
    const existing = await env.DB.prepare(
      'SELECT id FROM accounts WHERE ig_user_id = ?'
    ).bind(profile.user_id).first<{ id: string }>()

    const accountId = existing?.id || randomId()

    await env.DB.prepare(
      `INSERT OR REPLACE INTO accounts
         (id, ig_user_id, username, access_token, token_expires_at, connected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE((SELECT connected_at FROM accounts WHERE ig_user_id = ?), ?), COALESCE((SELECT created_at FROM accounts WHERE ig_user_id = ?), ?), ?)`
    ).bind(
      accountId,
      profile.user_id,
      profile.username,
      token.access_token,
      token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
      profile.user_id,
      now,
      profile.user_id,
      now,
      now,
    ).run()

    const redirectUrl = `${env.WEB_ORIGIN.replace(/\/$/, '')}/?connected=1`
    return Response.redirect(redirectUrl, 302)
  }

  throw new HttpError(404, 'Not found.')
}

async function getSessionStatus(request: Request, env: Env): Promise<SessionStatus> {
  const setupRequired = !(await appPasswordExists(env))
  const authenticated = setupRequired ? false : await isAuthenticated(request, env)
  return { authenticated, setupRequired }
}

async function requireAuth(request: Request, env: Env): Promise<void> {
  const setupRequired = !(await appPasswordExists(env))
  if (setupRequired) throw new HttpError(401, 'App password has not been set yet.')
  const ok = await isAuthenticated(request, env)
  if (!ok) throw new HttpError(401, 'Not authenticated.')
}

async function appPasswordExists(env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind('password_hash')
    .first<{ value: string }>()
  return Boolean(row?.value)
}

async function verifyPassword(password: string, env: Env): Promise<boolean> {
  validatePassword(password)
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind('password_hash')
    .first<{ value: string }>()
  if (!row?.value) return false
  const [salt, stored] = row.value.split(':')
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${salt}:${password}:${env.SESSION_SECRET}`),
  )
  const actual = toHex(hashBuffer)
  return timingSafeEqual(actual, stored)
}

async function hashPassword(password: string, env: Env): Promise<string> {
  const salt = randomId()
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${salt}:${password}:${env.SESSION_SECRET}`),
  )
  return `${salt}:${toHex(hashBuffer)}`
}

function validatePassword(password: string): void {
  if (!password || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.')
  }
}

async function createSessionResponse(env: Env): Promise<Response> {
  const sessionId = randomId()
  const now = Date.now()
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString()
  await env.DB.prepare(
    'INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)'
  ).bind(sessionId, new Date(now).toISOString(), expiresAt).run()

  return cors(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(sessionId, env),
      },
    }),
    env,
  )
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const sessionId = getCookie(request, SESSION_COOKIE)
  if (!sessionId) return false

  const row = await env.DB.prepare(
    'SELECT id, expires_at FROM sessions WHERE id = ?'
  ).bind(sessionId).first<{ id: string; expires_at: string }>()
  if (!row) return false
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run()
    return false
  }
  return true
}

async function listAccounts(env: Env) {
  const rows = await env.DB.prepare(
    'SELECT id, ig_user_id, username, connected_at, token_expires_at FROM accounts ORDER BY username ASC'
  ).all<AccountRow>()
  return rows.results || []
}

async function listLogs(env: Env) {
  const rows = await env.DB.prepare(
    'SELECT id, scheduled_post_id, account_id, level, message, created_at FROM publish_logs ORDER BY created_at DESC LIMIT 50'
  ).all()
  return rows.results || []
}

async function listPosts(env: Env) {
  const postRows = await env.DB.prepare(
    `SELECT sp.id, sp.caption, sp.media_asset_id, ma.media_url, ma.filename, sp.scheduled_for, sp.status, sp.created_at, sp.updated_at
     FROM scheduled_posts sp
     JOIN media_assets ma ON ma.id = sp.media_asset_id
     ORDER BY sp.scheduled_for ASC`
  ).all<any>()

  const targetRows = await env.DB.prepare(
    `SELECT spa.id, spa.scheduled_post_id, spa.account_id, a.username, spa.status, spa.published_at, spa.error_message
     FROM scheduled_post_accounts spa
     JOIN accounts a ON a.id = spa.account_id
     ORDER BY a.username ASC`
  ).all<TargetRow>()

  const targetsByPost = new Map<string, TargetRow[]>()
  for (const target of targetRows.results || []) {
    const list = targetsByPost.get(target.scheduled_post_id) || []
    list.push(target)
    targetsByPost.set(target.scheduled_post_id, list)
  }

  return (postRows.results || []).map((post) => ({
    ...post,
    targets: targetsByPost.get(post.id) || [],
  }))
}

async function getPostById(env: Env, postId: string) {
  const posts = await listPosts(env)
  const post = posts.find((item) => item.id === postId)
  if (!post) throw new HttpError(404, 'Post not found.')
  return post
}

async function runScheduler(env: Env): Promise<void> {
  const dueRows = await env.DB.prepare(
    `SELECT id
     FROM scheduled_posts
     WHERE status = 'scheduled'
       AND scheduled_for <= ?
     ORDER BY scheduled_for ASC
     LIMIT 10`
  ).bind(isoNow()).all<{ id: string }>()

  for (const row of dueRows.results || []) {
    await runPostPublish(env, row.id)
  }
}

async function runPostPublish(env: Env, postId: string): Promise<void> {
  const post = await env.DB.prepare(
    `SELECT sp.id, sp.caption, sp.media_asset_id, sp.scheduled_for, sp.status, ma.media_url
     FROM scheduled_posts sp
     JOIN media_assets ma ON ma.id = sp.media_asset_id
     WHERE sp.id = ?`
  ).bind(postId).first<ScheduledPostRow & { media_url: string }>()

  if (!post || post.status !== 'scheduled') return

  await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'running', updated_at = ? WHERE id = ?`
  ).bind(isoNow(), postId).run()

  const targets = await env.DB.prepare(
    `SELECT spa.id, spa.account_id, a.ig_user_id, a.username, a.access_token
     FROM scheduled_post_accounts spa
     JOIN accounts a ON a.id = spa.account_id
     WHERE spa.scheduled_post_id = ? AND spa.status = 'pending'`
  ).bind(postId).all<any>()

  let successCount = 0
  let failCount = 0

  for (const target of targets.results || []) {
    try {
      const containerId = await createInstagramMediaContainer({
        igUserId: target.ig_user_id,
        accessToken: target.access_token,
        imageUrl: post.media_url,
        caption: post.caption,
      })

      const publishId = await publishInstagramMedia({
        igUserId: target.ig_user_id,
        accessToken: target.access_token,
        creationId: containerId,
      })

      await env.DB.prepare(
        `UPDATE scheduled_post_accounts
         SET status = 'published', published_media_id = ?, published_at = ?, error_message = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(publishId, isoNow(), isoNow(), target.id).run()

      await log(env, 'info', `Published scheduled post ${postId} to @${target.username}.`, postId, target.account_id)
      successCount += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Publish failed'
      await env.DB.prepare(
        `UPDATE scheduled_post_accounts
         SET status = 'failed', error_message = ?, updated_at = ?
         WHERE id = ?`
      ).bind(message, isoNow(), target.id).run()

      await log(env, 'error', `Failed publishing ${postId} to @${target.username}: ${message}`, postId, target.account_id)
      failCount += 1
    }
  }

  const status = successCount > 0 && failCount === 0
    ? 'complete'
    : successCount > 0 && failCount > 0
      ? 'partial'
      : 'failed'

  await env.DB.prepare(
    `UPDATE scheduled_posts SET status = ?, updated_at = ? WHERE id = ?`
  ).bind(status, isoNow(), postId).run()
}

async function log(env: Env, level: 'info' | 'error', message: string, scheduledPostId: string | null, accountId: string | null) {
  await env.DB.prepare(
    `INSERT INTO publish_logs (id, scheduled_post_id, account_id, level, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(randomId(), scheduledPostId, accountId, level, message, isoNow()).run()
}

async function exchangeInstagramCode(code: string, env: Env): Promise<{ access_token: string; user_id: string; expires_in?: number }> {
  const form = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: `${env.APP_BASE_URL.replace(/\/$/, '')}/api/auth/instagram/callback`,
    code,
  })

  const response = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: form,
  })

  const payload = await safeJson(response)
  if (!response.ok) throw new HttpError(400, `Instagram token exchange failed: ${stringifyErrorPayload(payload)}`)
  return payload as { access_token: string; user_id: string; expires_in?: number }
}

async function fetchInstagramProfile(accessToken: string): Promise<{ user_id: string; username: string }> {
  const url = new URL('https://graph.instagram.com/me')
  url.searchParams.set('fields', 'user_id,username')
  url.searchParams.set('access_token', accessToken)

  const response = await fetch(url)
  const payload = await safeJson(response)
  if (!response.ok) throw new HttpError(400, `Instagram profile fetch failed: ${stringifyErrorPayload(payload)}`)
  return payload as { user_id: string; username: string }
}

async function createInstagramMediaContainer(args: {
  igUserId: string
  accessToken: string
  imageUrl: string
  caption: string
}): Promise<string> {
  const url = new URL(`https://graph.facebook.com/v22.0/${args.igUserId}/media`)
  url.searchParams.set('image_url', args.imageUrl)
  url.searchParams.set('caption', args.caption)
  url.searchParams.set('access_token', args.accessToken)

  const response = await fetch(url, { method: 'POST' })
  const payload = await safeJson(response)
  if (!response.ok) throw new Error(`Container create failed: ${stringifyErrorPayload(payload)}`)
  const id = String((payload as any).id || '')
  if (!id) throw new Error('Container create returned no id.')
  return id
}

async function publishInstagramMedia(args: {
  igUserId: string
  accessToken: string
  creationId: string
}): Promise<string> {
  const url = new URL(`https://graph.facebook.com/v22.0/${args.igUserId}/media_publish`)
  url.searchParams.set('creation_id', args.creationId)
  url.searchParams.set('access_token', args.accessToken)

  const response = await fetch(url, { method: 'POST' })
  const payload = await safeJson(response)
  if (!response.ok) throw new Error(`Publish failed: ${stringifyErrorPayload(payload)}`)
  const id = String((payload as any).id || '')
  if (!id) throw new Error('Publish returned no media id.')
  return id
}

async function makeSignedState(env: Env, payload: JsonRecord): Promise<string> {
  const raw = JSON.stringify(payload)
  const sig = await sign(raw, env)
  return btoa(`${raw}.${sig}`)
}

async function parseSignedState(value: string, env: Env): Promise<JsonRecord> {
  const decoded = atob(value)
  const dot = decoded.lastIndexOf('.')
  if (dot <= 0) throw new HttpError(400, 'Invalid state.')
  const raw = decoded.slice(0, dot)
  const actualSig = decoded.slice(dot + 1)
  const expectedSig = await sign(raw, env)
  if (!timingSafeEqual(actualSig, expectedSig)) throw new HttpError(400, 'Invalid state signature.')
  const payload = JSON.parse(raw)
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'Invalid state payload.')
  return payload
}

async function sign(value: string, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return toHex(signature)
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

function stringifyErrorPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const anyPayload = payload as any
    if (anyPayload.error?.message) return anyPayload.error.message
    if (anyPayload.message) return anyPayload.message
    return JSON.stringify(payload)
  }
  return 'Unknown error'
}

function getExtension(filename: string, mimeType: string): string {
  const byName = filename.split('.').pop()?.toLowerCase()
  if (byName) return byName
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

function sessionCookie(value: string, env: Env): string {
  const secure = env.APP_BASE_URL.startsWith('https://') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
}

function expiredSessionCookie(env: Env): string {
  const secure = env.APP_BASE_URL.startsWith('https://') ? '; Secure' : ''
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie')
  if (!cookieHeader) return null
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

function cors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', env.WEB_ORIGIN)
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.set('Access-Control-Allow-Headers', 'Content-Type')
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function json(value: unknown, status: number, env: Env): Response {
  return cors(
    new Response(JSON.stringify(value), {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
    env,
  )
}

function isoNow(): string {
  return new Date().toISOString()
}

function randomId(): string {
  return crypto.randomUUID()
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return result === 0
}

class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const encoder = new TextEncoder()
