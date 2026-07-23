// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LoginView } from './LoginView'

describe('LoginView', () => {
  it('shows only configured external providers and no local credential fields', () => {
    render(<LoginView providers={[{ key: 'organization', label: 'Organization' }]} />)
    expect(screen.getByRole('link', { name: 'Organizationで続ける' }).getAttribute('href')).toBe('/auth/login/organization')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/IDやパスワードはこのアプリには入力しません。/)).toBeTruthy()
  })
})
