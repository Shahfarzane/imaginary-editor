import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { uuid } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// What a page served over plain HTTP gets: getRandomValues, no randomUUID.
const insecureCrypto = () => vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })

describe('uuid', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('makes version 4 UUIDs', () => {
    expect(uuid()).toMatch(V4)
  })

  it('makes distinct version 4 UUIDs without crypto.randomUUID', () => {
    insecureCrypto()
    const ids = Array.from({ length: 1000 }, uuid)
    for (const id of ids) expect(id).toMatch(V4)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lets the photo store load without crypto.randomUUID', async () => {
    insecureCrypto()
    vi.resetModules()
    await expect(import('./db')).resolves.toHaveProperty('loadUserPresets')
  })
})
