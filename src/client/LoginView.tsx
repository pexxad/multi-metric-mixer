import { CircleAlert, Layers3 } from 'lucide-react'
import type { AuthProvider } from './api'

export function LoginView({ providers, error }: { providers: AuthProvider[]; error?: string }) {
  return <main className="auth-screen"><section className="auth-card">
    <div className="brand-mark"><Layers3 size={20} /><span>MMM</span></div>
    <span className="kicker">MULTI METRIC MIXER</span><h1>サインイン</h1>
    <p>組織の認証プロバイダーを選択してください。IDやパスワードはこのアプリには入力しません。</p>
    {error ? <div className="connection-error"><CircleAlert size={14} />{error}</div> : null}
    {providers.map((provider) => <a className="connection-submit auth-provider-button" href={`/auth/login/${encodeURIComponent(provider.key)}`} key={provider.key}>
      {provider.label}で続ける
    </a>)}
    {providers.length === 0 ? <small>利用可能な認証プロバイダーがありません。管理者へ連絡してください。</small> : null}
  </section></main>
}

