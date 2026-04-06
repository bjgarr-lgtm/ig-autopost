export type Account = {
  id: string
  ig_user_id: string
  username: string
  connected_at: string
  token_expires_at: string | null
}

export type ScheduledPost = {
  id: string
  caption: string
  media_asset_id: string
  media_url: string
  filename: string
  scheduled_for: string
  status: 'draft' | 'scheduled' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled'
  created_at: string
  updated_at: string
  targets: PostTarget[]
}

export type PostTarget = {
  id: string
  account_id: string
  username: string
  status: 'pending' | 'published' | 'failed' | 'cancelled'
  published_at: string | null
  error_message: string | null
}

export type PublishLog = {
  id: string
  scheduled_post_id: string | null
  account_id: string | null
  level: 'info' | 'error'
  message: string
  created_at: string
}

export type SessionStatus = {
  authenticated: boolean
  setupRequired: boolean
}

export type DashboardData = {
  session: SessionStatus
  accounts: Account[]
  posts: ScheduledPost[]
  logs: PublishLog[]
}
