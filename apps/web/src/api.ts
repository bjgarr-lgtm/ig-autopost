import type { Account, DashboardData, PublishLog, ScheduledPost, SessionStatus } from './types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers || {}),
    },
    ...init,
  })

  if (response.status === 204) {
    return undefined as T
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : await response.text()

  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : payload?.error || 'Request failed'
    throw new Error(message)
  }

  return payload as T
}

export const api = {
  async getDashboard(): Promise<DashboardData> {
    return request('/api/dashboard')
  },

  async getSession(): Promise<SessionStatus> {
    return request('/api/session')
  },

  async setupPassword(password: string): Promise<void> {
    return request('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    })
  },

  async login(password: string): Promise<void> {
    return request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    })
  },

  async logout(): Promise<void> {
    return request('/api/logout', { method: 'POST' })
  },

  async listAccounts(): Promise<Account[]> {
    return request('/api/accounts')
  },

  async listPosts(): Promise<ScheduledPost[]> {
    return request('/api/posts')
  },

  async listLogs(): Promise<PublishLog[]> {
    return request('/api/logs')
  },

  getInstagramConnectUrl(): string {
    return `${API_BASE}/api/auth/instagram/start`
  },

  async uploadMedia(file: File): Promise<{ mediaAssetId: string; mediaUrl: string; filename: string }> {
    const body = new FormData()
    body.append('file', file)
    return request('/api/upload', { method: 'POST', body })
  },

  async createPost(input: {
    caption: string
    scheduledFor: string
    mediaAssetId: string
    accountIds: string[]
  }): Promise<ScheduledPost> {
    return request('/api/posts', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async deletePost(id: string): Promise<void> {
    return request(`/api/posts/${id}`, { method: 'DELETE' })
  },
}
