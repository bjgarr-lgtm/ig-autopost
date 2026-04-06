import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { Account, DashboardData, PublishLog, ScheduledPost } from './types'

type Toast = { kind: 'error' | 'success'; message: string } | null

const emptyDashboard: DashboardData = {
  session: { authenticated: false, setupRequired: false },
  accounts: [],
  posts: [],
  logs: [],
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardData>(emptyDashboard)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<Toast>(null)

  async function load() {
    setLoading(true)
    try {
      const data = await api.getDashboard()
      setDashboard(data)
    } catch (error) {
      setToast({ kind: 'error', message: error instanceof Error ? error.message : 'Failed to load dashboard' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (loading) {
    return <div className="screen center">Loading. Because apparently software must warm up first.</div>
  }

  if (!dashboard.session.authenticated || dashboard.session.setupRequired) {
    return (
      <div className="screen auth-shell">
        <AuthGate
          setupRequired={dashboard.session.setupRequired}
          onSuccess={async () => {
            await load()
            setToast({ kind: 'success', message: 'Signed in.' })
          }}
          onError={(message) => setToast({ kind: 'error', message })}
        />
        {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
      </div>
    )
  }

  return (
    <div className="screen">
      <header className="topbar">
        <div>
          <h1>IG Autopost</h1>
          <p>One dashboard. Multiple IG accounts. Minimal ceremony. Humanity survives another day.</p>
        </div>
        <div className="topbar-actions">
          <a className="button button-primary" href={api.getInstagramConnectUrl()}>
            Connect Instagram account
          </a>
          <button
            className="button"
            onClick={async () => {
              try {
                await api.logout()
                await load()
              } catch (error) {
                setToast({ kind: 'error', message: error instanceof Error ? error.message : 'Logout failed' })
              }
            }}
          >
            Log out
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="card">
          <div className="card-header">
            <div>
              <h2>New scheduled post</h2>
              <p>Upload once, pick accounts, schedule it, leave.</p>
            </div>
          </div>
          <ComposeCard
            accounts={dashboard.accounts}
            onCreated={async () => {
              await load()
              setToast({ kind: 'success', message: 'Post scheduled.' })
            }}
            onError={(message) => setToast({ kind: 'error', message })}
          />
        </section>

        <section className="grid two">
          <StatsCard posts={dashboard.posts} accounts={dashboard.accounts} logs={dashboard.logs} />
          <ConnectedAccountsCard accounts={dashboard.accounts} />
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h2>Scheduled posts</h2>
              <p>Status per account. Brutally specific, unlike most platforms.</p>
            </div>
          </div>
          <ScheduledPostsTable
            posts={dashboard.posts}
            onDeleted={async (id) => {
              try {
                await api.deletePost(id)
                await load()
                setToast({ kind: 'success', message: 'Post deleted.' })
              } catch (error) {
                setToast({ kind: 'error', message: error instanceof Error ? error.message : 'Delete failed' })
              }
            }}
          />
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h2>Recent logs</h2>
              <p>Latest scheduler and publish activity.</p>
            </div>
          </div>
          <LogsList logs={dashboard.logs} />
        </section>
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </div>
  )
}

function AuthGate(props: {
  setupRequired: boolean
  onSuccess: () => Promise<void>
  onError: (message: string) => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!password.trim()) {
      props.onError('Password required.')
      return
    }
    setBusy(true)
    try {
      if (props.setupRequired) {
        await api.setupPassword(password)
      } else {
        await api.login(password)
      }
      setPassword('')
      await props.onSuccess()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card auth-card" onSubmit={submit}>
      <h1>{props.setupRequired ? 'Create admin password' : 'Sign in'}</h1>
      <p>
        {props.setupRequired
          ? 'First run only. Set one password for this dashboard.'
          : 'Single-user lock screen. Because the internet is full of goblins.'}
      </p>
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter password"
        />
      </label>
      <button className="button button-primary" disabled={busy} type="submit">
        {busy ? 'Working...' : props.setupRequired ? 'Save password' : 'Sign in'}
      </button>
    </form>
  )
}

function ComposeCard(props: {
  accounts: Account[]
  onCreated: () => Promise<void>
  onError: (message: string) => void
}) {
  const [caption, setCaption] = useState('')
  const [scheduledFor, setScheduledFor] = useState(defaultDateTimeLocal())
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!file) {
      props.onError('Choose an image first.')
      return
    }
    if (!selectedAccounts.length) {
      props.onError('Choose at least one account.')
      return
    }

    setBusy(true)
    try {
      const upload = await api.uploadMedia(file)
      await api.createPost({
        caption,
        scheduledFor: new Date(scheduledFor).toISOString(),
        mediaAssetId: upload.mediaAssetId,
        accountIds: selectedAccounts,
      })
      setCaption('')
      setScheduledFor(defaultDateTimeLocal())
      setSelectedAccounts([])
      setFile(null)
      const input = document.getElementById('media-input') as HTMLInputElement | null
      if (input) input.value = ''
      await props.onCreated()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Could not schedule post')
    } finally {
      setBusy(false)
    }
  }

  const hasAccounts = props.accounts.length > 0

  return (
    <form className="compose-form" onSubmit={submit}>
      <label className="field">
        <span>Image</span>
        <input id="media-input" type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] || null)} />
      </label>

      <label className="field">
        <span>Caption</span>
        <textarea
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          rows={7}
          placeholder="Write caption here"
        />
      </label>

      <label className="field">
        <span>Schedule time</span>
        <input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
      </label>

      <div className="field">
        <span>Post to accounts</span>
        {hasAccounts ? (
          <div className="checkbox-list">
            {props.accounts.map((account) => {
              const checked = selectedAccounts.includes(account.id)
              return (
                <label key={account.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelectedAccounts((prev) =>
                        checked ? prev.filter((id) => id !== account.id) : [...prev, account.id],
                      )
                    }
                  />
                  <span>@{account.username}</span>
                </label>
              )
            })}
          </div>
        ) : (
          <div className="empty-callout">
            No connected accounts yet. Connect at least one Instagram professional account first.
          </div>
        )}
      </div>

      <button className="button button-primary" type="submit" disabled={busy || !hasAccounts}>
        {busy ? 'Scheduling...' : 'Schedule post'}
      </button>
    </form>
  )
}

function StatsCard(props: { posts: ScheduledPost[]; accounts: Account[]; logs: PublishLog[] }) {
  const scheduled = props.posts.filter((post) => post.status === 'scheduled').length
  const dueFailures = props.logs.filter((log) => log.level === 'error').length
  const completed = props.posts.filter((post) => post.status === 'complete').length

  return (
    <div className="card stats-card">
      <div className="card-header">
        <div>
          <h2>Snapshot</h2>
          <p>Enough numbers to keep panic organized.</p>
        </div>
      </div>
      <div className="stats-grid">
        <Metric label="Connected accounts" value={String(props.accounts.length)} />
        <Metric label="Scheduled posts" value={String(scheduled)} />
        <Metric label="Completed posts" value={String(completed)} />
        <Metric label="Errors logged" value={String(dueFailures)} />
      </div>
    </div>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-value">{props.value}</div>
      <div className="metric-label">{props.label}</div>
    </div>
  )
}

function ConnectedAccountsCard(props: { accounts: Account[] }) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2>Connected accounts</h2>
          <p>Every selected post publishes separately to each account.</p>
        </div>
      </div>
      {props.accounts.length ? (
        <ul className="account-list">
          {props.accounts.map((account) => (
            <li key={account.id} className="account-row">
              <div>
                <strong>@{account.username}</strong>
                <div className="muted">IG user id: {account.ig_user_id}</div>
              </div>
              <div className="muted">Connected {formatDate(account.connected_at)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-callout">No Instagram accounts connected yet.</div>
      )}
    </div>
  )
}

function ScheduledPostsTable(props: { posts: ScheduledPost[]; onDeleted: (id: string) => void }) {
  if (!props.posts.length) {
    return <div className="empty-callout">No posts scheduled yet.</div>
  }

  return (
    <div className="table-shell">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Media</th>
            <th>Caption</th>
            <th>Status</th>
            <th>Targets</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {props.posts.map((post) => (
            <tr key={post.id}>
              <td>{formatDate(post.scheduled_for)}</td>
              <td>
                <a className="media-link" href={post.media_url} target="_blank" rel="noreferrer">
                  {post.filename}
                </a>
              </td>
              <td className="caption-cell">{post.caption || <span className="muted">No caption</span>}</td>
              <td>
                <span className={`status-pill ${post.status}`}>{post.status}</span>
              </td>
              <td>
                <div className="targets">
                  {post.targets.map((target) => (
                    <div key={target.id} className="target-chip">
                      <span>@{target.username}</span>
                      <span className={`status-dot ${target.status}`} />
                    </div>
                  ))}
                </div>
              </td>
              <td>
                {post.status === 'scheduled' || post.status === 'draft' ? (
                  <button className="button button-danger" onClick={() => props.onDeleted(post.id)}>
                    Delete
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LogsList(props: { logs: PublishLog[] }) {
  if (!props.logs.length) {
    return <div className="empty-callout">No logs yet.</div>
  }

  return (
    <div className="log-list">
      {props.logs.map((log) => (
        <div key={log.id} className={`log-row ${log.level}`}>
          <div className="log-meta">
            <span className={`status-pill ${log.level === 'error' ? 'failed' : 'complete'}`}>{log.level}</span>
            <span>{formatDate(log.created_at)}</span>
          </div>
          <div>{log.message}</div>
        </div>
      ))}
    </div>
  )
}

function defaultDateTimeLocal() {
  const date = new Date(Date.now() + 10 * 60 * 1000)
  date.setSeconds(0, 0)
  const offset = date.getTimezoneOffset()
  const local = new Date(date.getTime() - offset * 60000)
  return local.toISOString().slice(0, 16)
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}
