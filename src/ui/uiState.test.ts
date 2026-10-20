import { describe, expect, it } from 'vite-plus/test'
import { stepZoom, useUi, zoomLabel } from './uiState'

describe('zoom levels', () => {
  it('steps from fit to the next level around the fit scale', () => {
    useUi.setState({ zoom: 'fit', fitScale: 0.14 })
    stepZoom(1)
    expect(useUi.getState().zoom).toBe(0.3)
    useUi.setState({ zoom: 'fit', fitScale: 0.14 })
    stepZoom(-1)
    expect(useUi.getState().zoom).toBe(0.1)
  })

  it('steps through fit when it lies between two levels', () => {
    useUi.setState({ zoom: 2, fitScale: 1.2 })
    stepZoom(-1)
    expect(useUi.getState().zoom).toBe('fit')
    stepZoom(-1)
    expect(useUi.getState().zoom).toBe(1)
    useUi.setState({ zoom: 'fit', fitScale: 1.2 })
    stepZoom(1)
    expect(useUi.getState().zoom).toBe(2)
  })

  it('walks the menu levels and clamps at the ends', () => {
    useUi.setState({ zoom: 1, fitScale: 0.14 })
    stepZoom(1)
    expect(useUi.getState().zoom).toBe(2)
    useUi.setState({ zoom: 15 })
    stepZoom(1)
    expect(useUi.getState().zoom).toBe(15)
    useUi.setState({ zoom: 0.1 })
    stepZoom(-1)
    expect(useUi.getState().zoom).toBe(0.1)
  })

  it('labels levels like the menu', () => {
    expect(zoomLabel('fit')).toBe('Fit')
    expect(zoomLabel(0.3)).toBe('30%')
    expect(zoomLabel(15)).toBe('1500%')
  })
})
