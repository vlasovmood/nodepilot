import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, LogIn, Moon, ShieldCheck, Sun, UserPlus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiRequestError, errorMessage, isTwoFactorRequired } from '../../api/client'
import { qk } from '../../api/queries'
import type { AuthStatus, Credentials, LoginResponse } from '../../api/types'
import { Field } from '../../components/Field'
import { LanguageSelect } from '../../components/LanguageSelect'
import { Spinner } from '../../components/States'
import { formatRelative } from '../../lib/format'
import { useTheme } from '../../lib/theme'
import { BrandLogo } from '../../components/Logo'

type Step = 'password' | 'code'

export function AuthPage({ setupRequired }: { setupRequired: boolean }) {
  const { t } = useTranslation('auth')
  const qc = useQueryClient()
  const [theme, , toggleTheme] = useTheme()
  const [username, setUsername] = useState(setupRequired ? 'admin' : '')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [step, setStep] = useState<Step>('password')
  const [code, setCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Too many failed attempts: the server's Retry-After as an absolute time. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!lockedUntil) return
    const timer = window.setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= lockedUntil) setLockedUntil(null)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [lockedUntil])

  const m = useMutation({
    mutationFn: (c: Credentials): Promise<LoginResponse> => (setupRequired ? api.auth.setup(c) : api.auth.login(c)),
    onSuccess: (res) => {
      qc.setQueryData<AuthStatus>(qk.authStatus, {
        setup_required: false,
        user: res.user,
      })
    },
    onError: (e) => {
      if (isTwoFactorRequired(e)) {
        // Password accepted, a second factor is needed (or the code was missing).
        if (step === 'password') {
          setStep('code')
          setError(null)
        } else setError(t('errors.invalidCode'))
        return
      }
      if (e instanceof ApiRequestError && e.status === 429) {
        if (e.retryAfter !== null) {
          setLockedUntil(Date.now() + e.retryAfter * 1000)
          setNow(Date.now())
          setError(null)
        } else setError(e.message)
        return
      }
      if (e instanceof ApiRequestError && e.status === 401 && !setupRequired) {
        setError(step === 'code' ? t('errors.invalidCode') : t('errors.invalidCredentials'))
        return
      }
      setError(errorMessage(e))
    },
  })

  const locked = !!lockedUntil && lockedUntil > now
  const lockMessage = locked
    ? t('errors.tooMany', {
        time: formatRelative(new Date(Math.max(lockedUntil, now + 1000)).toISOString()),
      })
    : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (locked) return
    if (step === 'code') {
      const c = code.trim()
      if (!c) {
        setError(useRecovery ? t('twoFactor.enterRecovery') : t('twoFactor.enterCode'))
        return
      }
      m.mutate({ username, password, code: c })
      return
    }
    if (!username.trim() || !password) {
      setError(t('errors.required'))
      return
    }
    if (setupRequired) {
      if (password.length < 8) {
        setError(t('errors.passwordShort'))
        return
      }
      if (password !== password2) {
        setError(t('errors.passwordMismatch'))
        return
      }
    }
    m.mutate({ username, password })
  }

  const back = () => {
    setStep('password')
    setCode('')
    setUseRecovery(false)
    setError(null)
  }

  return (
    <div className="auth-screen">
      <div className="row" style={{ position: 'fixed', top: 12, insetInlineEnd: 12, gap: 6 }}>
        <LanguageSelect small style={{ width: 'auto' }} />
        <button className="btn btn-ghost btn-icon" onClick={toggleTheme} title={t('toggleTheme')} aria-label={t('toggleTheme')}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand-big">
          <BrandLogo height={84} />
        </div>
        {step === 'code' ? (
          <>
            <div>
              <h2 className="row" style={{ gap: 8 }}>
                <ShieldCheck size={18} /> {t('twoFactor.title')}
              </h2>
              <div className="muted small" style={{ marginTop: 4 }}>
                {useRecovery ? t('twoFactor.recoverySubtitle') : t('twoFactor.subtitle')}
              </div>
            </div>
            {useRecovery ? (
              <Field label={t('twoFactor.recoveryCode')}>
                <input
                  key="recovery"
                  className="input mono"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="a1b2c-3d4e5"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
            ) : (
              <Field label={t('twoFactor.code')}>
                <input
                  key="totp"
                  className="input mono totp-input"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </Field>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setUseRecovery(!useRecovery)
                setCode('')
                setError(null)
              }}
            >
              {useRecovery ? t('twoFactor.useApp') : t('twoFactor.useRecovery')}
            </button>
          </>
        ) : (
          <>
            <div>
              <h2>{setupRequired ? t('setup.title') : t('login.title')}</h2>
              <div className="muted small" style={{ marginTop: 4 }}>
                {setupRequired ? t('setup.subtitle') : t('login.subtitle')}
              </div>
            </div>
            <Field label={t('fields.username')}>
              <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label={t('fields.password')}>
              <input
                className="input"
                type="password"
                autoComplete={setupRequired ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {setupRequired && (
              <Field label={t('fields.password2')}>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        {lockMessage ? (
          <div className="alert alert-warn" role="alert" data-testid="login-locked">
            {lockMessage}
          </div>
        ) : (
          error && (
            <div className="field-error" role="alert" data-testid="login-error">
              {error}
            </div>
          )
        )}
        <button className="btn btn-primary" type="submit" disabled={m.isPending || locked} style={{ height: 34 }}>
          {m.isPending ? <Spinner /> : setupRequired ? <UserPlus size={15} /> : <LogIn size={15} />}
          {setupRequired ? t('setup.submit') : step === 'code' ? t('twoFactor.submit') : t('login.submit')}
        </button>
        {step === 'code' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={back} disabled={m.isPending}>
            <ArrowLeft size={14} /> {t('twoFactor.back')}
          </button>
        )}
      </form>
    </div>
  )
}
