import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { useCollections } from './collections'

describe('collections', () => {
  beforeEach(() => useCollections.setState({ list: [] }))

  it('groups picked presets once each, in the order they were picked', () => {
    useCollections.getState().create('  Mine ', ['CN1', 'PR2', 'CN1'])
    const [c] = useCollections.getState().list
    expect(c.name).toBe('Mine')
    expect(c.codes).toEqual(['CN1', 'PR2'])
  })

  it('adds and drops presets, renames and removes a collection', () => {
    const C = useCollections.getState()
    C.create('', ['CN1'])
    const id = useCollections.getState().list[0].id
    expect(useCollections.getState().list[0].name).toBe('Collection 1')
    C.add(id, ['PR2', 'CN1', 'VV3'])
    expect(useCollections.getState().list[0].codes).toEqual(['CN1', 'PR2', 'VV3'])
    C.drop(id, ['CN1', 'VV3'])
    expect(useCollections.getState().list[0].codes).toEqual(['PR2'])
    C.rename(id, '   ')
    expect(useCollections.getState().list[0].name).toBe('Collection 1')
    C.rename(id, 'Warm')
    expect(useCollections.getState().list[0].name).toBe('Warm')
    C.remove(id)
    expect(useCollections.getState().list).toEqual([])
  })
})
