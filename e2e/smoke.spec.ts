import { expect, test, type Page } from '@playwright/test'
import { importFiles, open } from './helpers'

// The main flows end to end. Fixtures are synthetic: chart.jpg (a gradient with three shapes) and
// chart.heic, the same image converted with macOS sips.

type Studio = { lib: { getState(): { photos: { name: string; edit: { preset: { id: string | null }; tools: Record<string, number>; crop: { aspect: string } } }[] } } }
const photos = (page: Page) =>
  page.evaluate(() => (window as unknown as { __studio: Studio }).__studio.lib.getState().photos.map((p) => ({ name: p.name, edit: p.edit })))

test('import, preset, reset, tools, crop and export', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')

  // Pick a preset from the strip.
  const first = page.locator('[data-strip-code]').first()
  await first.click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  expect((await photos(page))[0].edit.preset.id).not.toBeNull()

  // The toolbar's Reset goes back to the original, and undo brings the preset back.
  await page.getByRole('button', { name: 'Reset to original' }).click()
  expect((await photos(page))[0].edit.preset.id).toBeNull()
  await expect(page.getByRole('button', { name: 'Reset to original' })).toBeDisabled()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await photos(page))[0].edit.preset.id).not.toBeNull()

  // A tool moves the edit.
  await page.getByRole('button', { name: 'Tools' }).click()
  const exposure = page.getByRole('spinbutton', { name: 'Exposure', exact: true })
  // A JPEG has no RAW Exposure.
  await expect(page.getByRole('spinbutton', { name: 'RAW Exposure' })).toHaveCount(0)
  await exposure.fill('2')
  await exposure.press('Enter')
  await expect.poll(async () => (await photos(page))[0].edit.tools.exposure).toBeGreaterThan(0)

  // Crop to square; in crop the rail offers the way back instead of Add and the grid slider.
  await page.getByRole('button', { name: 'Adjust' }).click()
  await page.getByRole('button', { name: '1:1' }).click()
  await expect(page.getByRole('button', { name: 'Back to grid' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Grid size' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Done' }).click()
  expect((await photos(page))[0].edit.crop.aspect).toBe('1:1')

  // Export downloads a square image. The page keeps the blob it hands to the download, to measure it.
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob | MediaSource) => (((window as unknown as { __out: unknown }).__out = b), create(b))
  })
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 1 photo' }).click()
  expect((await download).suggestedFilename()).toMatch(/^chart_.+_edit\.jpg$/)
  const size = await page.evaluate(async () => {
    const bmp = await createImageBitmap((window as unknown as { __out: Blob }).__out)
    return [bmp.width, bmp.height]
  })
  expect(size[0]).toBe(size[1])
  expect(size[0]).toBeGreaterThan(500)

  expect(errors).toEqual([])
})

test('HEIC imports and renders', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.heic')
  const [p] = await photos(page)
  expect(p.name).toBe('chart.heic')
  // The decoded photo matches the JPEG it came from: the red square stays red.
  const px = await page.evaluate(async () => {
    // Through the app's own module graph, as the dev server serves it.
    const renderModule: string = '/src/store/render.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const blob = await (await fetch('/e2e/fixtures/chart.heic')).blob()
    const bmp = await r.decodeBlob(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    return [bmp.width, bmp.height, ...g.getImageData(160, 160, 1, 1).data.slice(0, 3)]
  })
  expect(px.slice(0, 2)).toEqual([900, 600])
  expect(px[2]).toBeGreaterThan(170)
  expect(px[3]).toBeLessThan(80)
  expect(errors).toEqual([])
})

test('presets live in a strip under the grid and the photo, and P hides it', async ({ page }) => {
  const errors = await open(page)
  const strip = page.getByRole('navigation', { name: 'Preset strip' })
  await importFiles(page, 'chart.jpg', 'chart.heic')
  // The grid shows it for the selection, and a tile applies to every selected photo.
  await expect(strip).toBeVisible()
  await strip.locator('[data-strip-code]').first().click()
  await expect.poll(async () => (await photos(page)).map((p) => p.edit.preset.id)).toEqual([expect.any(String), expect.any(String)])
  const [a, b] = await photos(page)
  expect(b.edit.preset.id).toBe(a.edit.preset.id)
  await page.getByRole('button', { name: 'Single image' }).click()
  await expect(strip).toBeVisible()
  // P hides it, and the choice is kept.
  await page.keyboard.press('p')
  await expect(strip).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('studio.stripOpen'))).toBe('0')
  await page.getByRole('button', { name: 'Preset strip', exact: true }).click()
  await expect(strip).toBeVisible()
  expect(errors).toEqual([])
})

type Active = { id: string; edit: { preset: { id: string | null; tile?: string } } }
const active = (page: Page) =>
  page.evaluate(() => {
    const L = (window as unknown as { __studio: { lib: { getState(): { selected: string[]; photos: Active[] } } } }).__studio.lib.getState()
    return L.photos.find((p) => p.id === L.selected[0])!
  })

test('in the single view the arrow keys step through the presets sideways and the photos up and down', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg', 'chart.heic')
  await page.keyboard.press('Escape')
  await page.locator('[class*="_tile_"]').first().click()
  await page.getByRole('button', { name: 'Single image' }).click()
  const strip = page.getByRole('navigation', { name: 'Preset strip' })
  const codeAt = (n: number) => strip.locator(`[data-strip-pos="${n}"]`).getAttribute('data-strip-code')
  const first = (await active(page)).id
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await active(page)).edit.preset.tile).toBe(await codeAt(0))
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await active(page)).edit.preset.tile).toBe(await codeAt(1))
  await expect(strip.locator('[data-strip-pos="1"]')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await active(page)).edit.preset.tile).toBe(await codeAt(0))
  // Before the first preset is the photo without one.
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await active(page)).edit.preset.id).toBeNull()
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await active(page)).id).not.toBe(first)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await active(page)).id).toBe(first)
  expect(errors).toEqual([])
})

test('presets picked with a modifier click become a collection in the strip', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  const strip = page.getByRole('navigation', { name: 'Preset strip' })
  const lab = strip.getByRole('group', { name: 'Lab' }).locator('[data-strip-code]')
  await lab.nth(1).click({ modifiers: ['ControlOrMeta'] })
  await lab.nth(3).click({ modifiers: ['Shift'] })
  await expect(page.getByText('2 picked', { exact: true })).toBeVisible()
  // Picking does not apply a preset.
  expect((await photos(page))[0].edit.preset.id).toBeNull()
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Collection name').fill('Warm')
  await page.getByLabel('Collection name').press('Enter')
  const warm = strip.getByRole('group', { name: 'Warm' }).locator('[data-strip-code]')
  await expect(warm).toHaveCount(2)
  await expect(page.getByText('2 picked', { exact: true })).toBeHidden()
  // It is kept in the browser.
  await page.reload()
  await page.locator('[class*="_tile_"]').first().click()
  await expect(warm).toHaveCount(2)
  // Add to it, take out of it, then delete it from its label.
  await lab.nth(2).click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Add to Warm' }).click()
  await expect(warm).toHaveCount(3)
  await warm.first().click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Remove from Warm' }).click()
  await expect(warm).toHaveCount(2)
  await strip.getByRole('button', { name: 'collection Warm' }).dblclick()
  await page.getByRole('button', { name: 'Delete Warm', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Warm for good' }).click()
  await expect(strip.getByRole('group', { name: 'Warm' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a right-click adds a preset to a new or existing collection, or takes it out', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  const strip = page.getByRole('navigation', { name: 'Preset strip' })
  const lab = strip.getByRole('group', { name: 'Lab' }).locator('[data-strip-code]')
  await lab.nth(0).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New collection…' }).click()
  await page.getByLabel('Collection name').fill('Evening')
  await page.getByLabel('Collection name').press('Enter')
  const evening = strip.getByRole('group', { name: 'Evening' }).locator('[data-strip-code]')
  await expect(evening).toHaveCount(1)
  // The menu applies nothing to the photo.
  expect((await photos(page))[0].edit.preset.id).toBeNull()
  const item = page.getByRole('menuitemcheckbox', { name: 'Evening' })
  await lab.nth(2).click({ button: 'right' })
  await expect(item).toHaveAttribute('aria-checked', 'false')
  await item.click()
  await expect(evening).toHaveCount(2)
  await lab.nth(2).click({ button: 'right' })
  await expect(item).toHaveAttribute('aria-checked', 'true')
  await item.click()
  await expect(evening).toHaveCount(1)
  expect(errors).toEqual([])
})

test('dragging moves presets inside a set, into a collection, and whole groups; the order is kept', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  const strip = page.getByRole('navigation', { name: 'Preset strip' })
  const lab = strip.getByRole('group', { name: 'Lab' }).locator('[data-strip-code]')
  const codes = () => lab.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.stripCode))
  const groupNames = () => strip.getByRole('group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  const drag = async (from: import('@playwright/test').Locator, to: import('@playwright/test').Locator, after: boolean) => {
    const a = (await from.boundingBox())!
    const b = (await to.boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 })
    await page.mouse.move(b.x + b.width * (after ? 0.8 : 0.2), b.y + b.height / 2, { steps: 10 })
    await page.mouse.up()
  }
  const start = await codes()
  await drag(lab.nth(0), lab.nth(2), true)
  await expect.poll(codes).toEqual([start[1], start[2], start[0], ...start.slice(3)])
  // A drag applies nothing.
  expect((await photos(page))[0].edit.preset.id).toBeNull()
  // Into a collection.
  await lab.nth(3).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New collection…' }).click()
  await page.getByLabel('Collection name').fill('Keep')
  await page.getByLabel('Collection name').press('Enter')
  const keep = strip.getByRole('group', { name: 'Keep' }).locator('[data-strip-code]')
  await expect(keep).toHaveCount(1)
  await drag(lab.nth(1), keep.first(), true)
  await expect(keep).toHaveCount(2)
  // A whole group, by its label: the collection after the Lab set.
  expect((await groupNames()).slice(0, 2)).toEqual(['Keep', 'Lab'])
  await drag(strip.getByRole('button', { name: 'collection Keep' }), strip.getByRole('group', { name: 'Lab' }), true)
  await expect.poll(async () => (await groupNames()).slice(0, 2)).toEqual(['Lab', 'Keep'])
  // Kept across a reload, and the menu puts the catalog's order back.
  await page.reload()
  await page.locator('[class*="_tile_"]').first().click()
  await expect.poll(async () => (await groupNames()).slice(0, 2)).toEqual(['Lab', 'Keep'])
  await expect.poll(codes).toEqual([start[1], start[2], start[0], ...start.slice(3)])
  await lab.nth(0).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reset strip order' }).click()
  await expect.poll(codes).toEqual(start)
  await expect.poll(async () => (await groupNames()).slice(0, 2)).toEqual(['Keep', 'Lab'])
  expect(errors).toEqual([])
})

test('settings: the presets in the strip, in a Presets panel on the right, or both; one always stays on', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  const strip = page.getByRole('navigation', { name: 'Preset strip' })
  const panel = page.getByRole('complementary', { name: 'Presets' })
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const stripSwitch = page.getByRole('switch', { name: 'Preset strip' })
  const panelSwitch = page.getByRole('switch', { name: 'Presets panel' })
  const panelButton = page.getByRole('button', { name: 'Presets', exact: true })
  // By default the strip and no panel; the strip is the only place, so its switch is locked on.
  await expect(strip).toBeVisible()
  await expect(panelButton).toHaveCount(0)
  await settings.click()
  await expect(stripSwitch).toBeDisabled()
  // With the panel on, a Presets button among the panels opens the list in the right sidebar.
  await panelSwitch.click()
  await expect(stripSwitch).toBeEnabled()
  await page.keyboard.press('Escape')
  await panelButton.click()
  await expect(panel).toBeVisible()
  await expect(panelButton).toHaveAttribute('aria-pressed', 'true')
  const row = panel.locator('[aria-label^="list preset LB1:"]')
  await row.click()
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  expect((await photos(page))[0].edit.preset.id).not.toBeNull()
  // With the strip off, it and its button go, the panel's switch is locked on, and P opens and closes the panel.
  await settings.click()
  await stripSwitch.click()
  await expect(panelSwitch).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(strip).toBeHidden()
  await expect(page.getByRole('button', { name: 'Preset strip' })).toHaveCount(0)
  await page.keyboard.press('p')
  await expect(panel).toBeHidden()
  await page.keyboard.press('p')
  await expect(panel).toBeVisible()
  // The settings are kept across a reload.
  await page.reload()
  await page.locator('[class*="_tile_"]').first().click()
  await expect(strip).toBeHidden()
  await panelButton.click()
  await expect(panel).toBeVisible()
  // Back to the default: turning the panel off closes it, and the strip returns.
  await settings.click()
  await stripSwitch.click()
  await panelSwitch.click()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(panelButton).toHaveCount(0)
  await expect(strip).toBeVisible()
  expect(errors).toEqual([])
})

test('Cmd+K opens a command palette that runs commands and applies presets; the credits link home', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  // Presets show once something is typed; a code finds its preset, and Enter applies it.
  await page.keyboard.type('LB1')
  await expect(palette.getByRole('option').first()).toContainText('LB1')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  expect((await photos(page))[0].edit.preset.id).not.toBeNull()
  // A command: Tools opens its panel.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('tools')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: 'Tools' })).toBeVisible()
  // Cmd+K opens and closes it; the credit at its foot and in Settings links home.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette.getByRole('link', { name: 'Made by Shahin Farzane' })).toHaveAttribute('href', 'https://nerd.ceo')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Shahin Farzane' })).toHaveAttribute('href', 'https://nerd.ceo')
  expect(errors).toEqual([])
})

test('a large grid tile renders at its own size, not its 640 px thumbnail', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as unknown as { __studio: { lib: { getState(): { setGridSize(v: number): void } } } }).__studio.lib.getState().setGridSize(0.85))
  const tile = page.locator('[class*="_tile_"]').first()
  const size = () =>
    tile.evaluate((el) => {
      const c = el.querySelector('canvas')!
      return { want: Math.round(el.getBoundingClientRect().width * devicePixelRatio), got: c.width }
    })
  const { want } = await size()
  expect(want).toBeGreaterThan(640 * 1.15)
  await expect.poll(async () => Math.abs((await size()).got - want), { timeout: 10_000 }).toBeLessThanOrEqual(2)
  expect(errors).toEqual([])
})

test('the logo goes home: the whole library in the grid, nothing selected, no panel, from anywhere', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg', 'chart.heic')
  const tiles = page.locator('[class*="_tile_"]')
  const home = page.getByRole('button', { name: 'Home', exact: true })
  const selection = page.getByRole('toolbar', { name: 'Selection' })
  // It reads as a link home and takes the rail's full width.
  await expect(home).toHaveCSS('cursor', 'pointer')
  expect((await home.boundingBox())!.width).toBeGreaterThanOrEqual(36)
  await page.keyboard.press('Escape')
  // From the single view of an isolated photo with Tools open.
  await tiles.first().click()
  await page.keyboard.press('i')
  await expect(tiles).toHaveCount(1)
  await page.getByRole('button', { name: 'Single image' }).click()
  await expect(tiles).toHaveCount(0)
  await page.keyboard.press('t')
  await expect(page.getByRole('complementary', { name: 'Tools' })).toBeVisible()
  await home.click()
  await expect(tiles).toHaveCount(2)
  await expect(page.getByRole('complementary', { name: 'Tools' })).toHaveCount(0)
  await expect(selection).toHaveCount(0)
  // From crop.
  await tiles.first().click()
  await page.getByRole('button', { name: 'Adjust' }).click()
  await expect(page.getByRole('spinbutton', { name: 'Straighten', exact: true })).toBeVisible()
  await home.click()
  await expect(page.getByRole('spinbutton', { name: 'Straighten', exact: true })).toBeHidden()
  await expect(tiles).toHaveCount(2)
  await expect(selection).toHaveCount(0)
  // A grid filter goes too.
  await tiles.first().click()
  await page.keyboard.press('.')
  await page.getByRole('button', { name: 'Filter' }).first().click()
  await page.getByRole('button', { name: 'Favorites only' }).click()
  await expect(tiles).toHaveCount(1)
  await home.click()
  await expect(tiles).toHaveCount(2)
  expect(errors).toEqual([])
})

test('look sliders stay on the photo in the single view', async ({ page }) => {
  await open(page)
  await importFiles(page, 'chart.jpg')
  await page.locator('[data-strip-code]').first().click()
  // In the grid they sit above the strip, in the single view on the photo.
  await expect(page.getByRole('slider', { name: 'Strength' })).toBeVisible()
  await page.keyboard.press('g')
  await expect(page.getByRole('slider', { name: 'Strength' })).toBeVisible()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(2500)
  await expect(page.getByRole('slider', { name: 'Strength' })).toBeVisible()
})

test('the keyboard button toggles the shortcuts list, which takes the place of the open panel', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  const info = page.getByRole('button', { name: 'Info' })
  const keys = page.getByRole('button', { name: 'Keyboard shortcuts' })
  const list = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await info.click()
  await expect(info).toHaveAttribute('aria-pressed', 'true')
  // Opening the list closes Info; the button closes the list again and Info stays closed.
  await keys.click()
  await expect(list).toBeVisible()
  await expect(keys).toHaveAttribute('aria-pressed', 'true')
  await expect(info).toHaveAttribute('aria-pressed', 'false')
  await keys.click()
  await expect(list).toHaveCount(0)
  await expect(info).toHaveAttribute('aria-pressed', 'false')
  // A panel opening closes the list, from the rail or the keyboard.
  await keys.click()
  await info.click()
  await expect(list).toHaveCount(0)
  await expect(info).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('?')
  await expect(list).toBeVisible()
  await page.keyboard.press('t')
  await expect(list).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'true')
  expect(errors).toEqual([])
})

test('favorites, filters and the info panel', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg', 'chart.heic')
  // Favorite the first photo only (an import selects everything it adds).
  await page.keyboard.press('Escape')
  await page.locator('[class*="_tile_"]').first().click()
  await page.keyboard.press('.')
  await expect(page.getByLabel('Favorite', { exact: true })).toBeVisible()
  // The grid filters down to it from the rail's Filter menu, then back.
  const filterButton = page.getByRole('button', { name: 'Filter', exact: true })
  const filters = page.getByRole('region', { name: 'Filter' })
  await filterButton.click()
  await filters.getByRole('button', { name: 'Favorites only' }).click()
  await expect(page.locator('[class*="_tile_"]')).toHaveCount(1)
  await expect(filters.getByText('1 of 2')).toBeVisible()
  // Escape closes the menu and keeps the selection; the rail marks the filter that is still on.
  await page.keyboard.press('Escape')
  await expect(filters).toBeHidden()
  await expect(filterButton).toContainText('Filter on')
  await filterButton.click()
  await filters.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.locator('[class*="_tile_"]')).toHaveCount(2)
  // Info shows the file facts and the favorite.
  await page.getByRole('button', { name: 'Info' }).click()
  await expect(page.getByText('900 × 600 (0.5 MP)')).toBeVisible()
  await expect(page.getByText('No camera details in this file.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(errors).toEqual([])
})

test('save an edit as your own preset and apply it', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg', 'chart.heic')
  await page.keyboard.press('Escape')
  await page.locator('[class*="_tile_"]').first().click()
  await page.locator('[data-strip-code]').first().click()
  // With nothing saved yet the save tile stands alone, without the group's label.
  const yoursLabel = page.getByRole('navigation', { name: 'Preset strip' }).getByTitle('Your presets')
  await expect(yoursLabel).toHaveCount(0)
  await page.getByRole('button', { name: 'Save this edit as a preset' }).click()
  await page.getByLabel('Preset name').fill('My look')
  await page.getByLabel('Preset name').press('Enter')
  await expect(page.getByRole('button', { name: 'your preset My look' })).toBeVisible()
  await expect(yoursLabel).toHaveCount(1)
  // Apply it to the other photo: same look, one undo step.
  await page.locator('[class*="_tile_"]').nth(1).click()
  await page.getByRole('button', { name: 'your preset My look' }).click()
  const looks = await photos(page)
  expect(looks[1].edit.preset.id).toBe(looks[0].edit.preset.id)
  // It survives a reload; a double-click renames or deletes it, and deleting takes two clicks.
  await page.reload()
  await page.locator('[class*="_tile_"]').first().click()
  await page.getByRole('button', { name: 'your preset My look' }).dblclick()
  await page.getByRole('button', { name: 'Delete My look', exact: true }).click()
  await page.getByRole('button', { name: 'Delete My look for good' }).click()
  await expect(page.getByRole('button', { name: 'your preset My look' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a Display P3 photo renders in the colors the browser shows it in', async ({ page }) => {
  const errors = await open(page)
  // p3.png: five patches inside sRGB and three only in P3, stored as P3 values with a P3 profile.
  await importFiles(page, 'p3.png')
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const blob = await (await fetch('/e2e/fixtures/p3.png')).blob()
    const centers = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [(i % 4) * 32 + 16, Math.floor(i / 4) * 32 + 16])
    const read = (img: CanvasImageSource) => {
      const g = new OffscreenCanvas(128, 64).getContext('2d')!
      g.drawImage(img, 0, 0)
      return centers.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)))
    }
    // The browser's own color-managed conversion to sRGB is the reference.
    const want = read(await createImageBitmap(blob))
    const bmp = await r.decodeBlob(blob)
    const decoded = read(bmp)
    const out = r.getRenderer().renderBitmap(r.gpuSource('p3-test', bmp), defaultEdit(), 128, 64)
    return { want, decoded, rendered: read(out) }
  })
  // The thumbnail path (a 2D canvas) and the GPU render both match it; the P3-only colors clip like the browser's.
  for (const [i, want] of got.want.entries()) {
    for (const c of [0, 1, 2]) {
      expect(Math.abs(got.decoded[i][c] - want[c]), `decoded patch ${i}`).toBeLessThanOrEqual(2)
      expect(Math.abs(got.rendered[i][c] - want[c]), `rendered patch ${i}: ${got.rendered[i].join()} vs ${want.join()}`).toBeLessThanOrEqual(2)
    }
  }
  expect(errors).toEqual([])
})

test('Display P3 output keeps colors beyond sRGB, in a render and in an exported file', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'p3.png')
  const centers = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [(i % 4) * 32 + 16, Math.floor(i / 4) * 32 + 16])
  // The fixture's own P3 values, as the browser color-manages it into a P3 canvas.
  const readP3 = async (blobUrl: string | null) =>
    page.evaluate(
      async ([url, pts]) => {
        const blob = url ? await (await fetch(url)).blob() : (window as unknown as { __out: Blob }).__out
        const g = new OffscreenCanvas(128, 64).getContext('2d', { colorSpace: 'display-p3' })!
        g.drawImage(await createImageBitmap(blob), 0, 0)
        return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1, { colorSpace: 'display-p3' }).data.slice(0, 3)))
      },
      [blobUrl, centers] as const,
    )
  const want = await readP3('/e2e/fixtures/p3.png')
  // The renderer's P3 output, unedited: every patch comes back, the P3-only ones included.
  const rendered = await page.evaluate(async (pts) => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const ren = r.getRenderer()
    const bmp = await r.decodeBlob(await (await fetch('/e2e/fixtures/p3.png')).blob())
    const px: Uint8ClampedArray = await ren.renderPixels(ren.loadSource(bmp, r.bitmapSpace(bmp)), defaultEdit(1), 128, 64, undefined, 0, 'display-p3')
    return pts.map(([x, y]) => Array.from(px.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 3)))
  }, centers)
  for (const [i, w] of want.entries()) for (const c of [0, 1, 2]) expect(Math.abs(rendered[i][c] - w[c]), `rendered patch ${i}: ${rendered[i].join()} vs ${w.join()}`).toBeLessThanOrEqual(2)

  // The export panel's Display P3 PNG decodes to the same P3 values.
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob | MediaSource) => (((window as unknown as { __out: unknown }).__out = b), create(b))
  })
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('button', { name: 'PNG' }).click()
  await page.getByRole('button', { name: 'Display P3' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 1 photo' }).click()
  await download
  const exported = await readP3(null)
  for (const [i, w] of want.entries()) for (const c of [0, 1, 2]) expect(Math.abs(exported[i][c] - w[c]), `exported patch ${i}: ${exported[i].join()} vs ${w.join()}`).toBeLessThanOrEqual(2)
  expect(errors).toEqual([])
})

test('a preview render between export tiles does not change the export', async ({ page }) => {
  await open(page)
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const ren = r.getRenderer()
    const gray = (w: number, h: number) => {
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')!
      g.fillStyle = 'rgb(128,128,128)'
      g.fillRect(0, 0, w, h)
      return ren.loadSource(c.transferToImageBitmap())
    }
    // Two 2048 px tiles; Shadows so the export also leans on the shared guided-filter layers.
    const src = gray(4096, 64)
    const e = defaultEdit(1)
    e.tools.shadows = 0.5
    const sample = (px: Uint8ClampedArray) => [px[(32 * 4096 + 100) * 4], px[(32 * 4096 + 3000) * 4]]
    const baseline = sample(await ren.renderPixels(src, e, 4096, 64))
    // A preview of another photo, with other settings, lands in the export's yield after its first tile.
    const other = gray(512, 300)
    const p = defaultEdit(2)
    p.tools.exposure = -1
    p.tools.shadows = -0.5
    setTimeout(() => ren.renderBitmap(other, p, 512, 300).close(), 0)
    const interleaved = sample(await ren.renderPixels(src, e, 4096, 64))
    return { baseline, interleaved, error: ren.gl.getError() }
  })
  expect(got.error).toBe(0)
  expect(got.interleaved).toEqual(got.baseline)
})

test('without float render targets the renderer degrades without WebGL errors', async ({ page }) => {
  await open(page)
  const run = (blocked: string[]) =>
    page.evaluate(async (blocked) => {
      const rendererModule: string = '/src/engine/renderer.ts'
      const presetsModule: string = '/src/model/presets.ts'
      const editModule: string = '/src/model/edit.ts'
      const { Renderer } = await import(/* @vite-ignore */ rendererModule)
      const { lookFor } = await import(/* @vite-ignore */ presetsModule)
      const { defaultEdit } = await import(/* @vite-ignore */ editModule)
      // WebGL only makes float formats renderable once the extension is asked for, so hiding it is the real thing.
      const proto = WebGL2RenderingContext.prototype
      const original = Object.getOwnPropertyDescriptor(proto, 'getExtension')!.value as (this: WebGL2RenderingContext, n: string) => unknown
      proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
        return blocked.includes(name) ? null : original.call(this, name)
      } as typeof proto.getExtension
      const ren = Renderer.create(lookFor)!
      proto.getExtension = original as typeof proto.getExtension
      const c = new OffscreenCanvas(64, 64)
      const g = c.getContext('2d')!
      const grad = g.createLinearGradient(0, 0, 64, 0)
      grad.addColorStop(0, '#000')
      grad.addColorStop(1, '#fff')
      g.fillStyle = grad
      g.fillRect(0, 0, 64, 64)
      const src = ren.loadSource(c.transferToImageBitmap())
      const plain = defaultEdit(1)
      const shadows = defaultEdit(1)
      shadows.tools.shadows = 0.8
      const sum = (px: Uint8ClampedArray) => px.reduce((s, v) => s + v, 0)
      const pa = await ren.renderPixels(src, plain, 64, 64)
      const pb = await ren.renderPixels(src, shadows, 64, 64)
      // The unedited render has no dither and the Shadows edit does, so up to one level apart is no lift.
      const shadowsMaxDiff = pa.reduce((m: number, v: number, i: number) => Math.max(m, Math.abs(pb[i] - v)), 0)
      const lut = ren.readLut(plain)
      return { float: ren.floatTargets, error: ren.gl.getError(), shadowsLift: sum(pb) - sum(pa), shadowsMaxDiff, lutMax: Math.max(...lut.subarray(lut.length - 3)) }
    }, blocked)
  // No float targets at all: Shadows is unavailable (no lift) but nothing errors, and the LUT reads back.
  const none = await run(['EXT_color_buffer_float', 'EXT_color_buffer_half_float'])
  expect(none).toMatchObject({ float: false, error: 0 })
  expect(none.shadowsMaxDiff).toBeLessThanOrEqual(1)
  expect(none.lutMax).toBeGreaterThan(0.99)
  // Half-float targets only: Shadows works.
  const half = await run(['EXT_color_buffer_float'])
  expect(half).toMatchObject({ float: false, error: 0 })
  expect(half.shadowsLift).toBeGreaterThan(0)
  expect(half.lutMax).toBeGreaterThan(0.99)
})

test('on a wide-gamut screen the single view shows Display P3, through a read-back where bitmaps lose it', async ({ page, browserName }) => {
  // Headless browsers report an sRGB screen; claim a P3 one so the view takes its wide-gamut route (WebKit's
  // WebGL bitmaps lose their color space, so there it is the non-blocking read-back that Safari uses).
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => (q.includes('color-gamut: p3') ? ({ matches: true, media: q } as MediaQueryList) : original(q))
  })
  const errors = await open(page)
  await importFiles(page, 'p3.png')
  await page.keyboard.press('g')
  const main = page.locator('canvas[class*="mainCanvas"]').first()
  await expect(main).toHaveCSS('opacity', '1')
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const c = document.querySelector<HTMLCanvasElement>('canvas[class*="mainCanvas"]')!
    // Read what the view holds, as Display P3, at each patch center of the 128 x 64 fixture.
    const g = new OffscreenCanvas(c.width, c.height).getContext('2d', { colorSpace: 'display-p3' })!
    g.drawImage(c, 0, 0)
    const at = (i: number) => {
      const x = Math.floor((((i % 4) * 32 + 16) / 128) * c.width)
      const y = Math.floor(((Math.floor(i / 4) * 32 + 16) / 64) * c.height)
      return Array.from(g.getImageData(x, y, 1, 1, { colorSpace: 'display-p3' }).data.slice(0, 3))
    }
    const want = new OffscreenCanvas(128, 64).getContext('2d', { colorSpace: 'display-p3' })!
    want.drawImage(await createImageBitmap(await (await fetch('/e2e/fixtures/p3.png')).blob()), 0, 0)
    const expected = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Array.from(want.getImageData((i % 4) * 32 + 16, Math.floor(i / 4) * 32 + 16, 1, 1, { colorSpace: 'display-p3' }).data.slice(0, 3)))
    return { route: r.viewRoute(), shown: [0, 1, 2, 3, 4, 5, 6, 7].map(at), expected }
  })
  expect(got.route).toEqual({ space: 'display-p3', readback: browserName === 'webkit' })
  for (const [i, w] of got.expected.entries())
    for (const c of [0, 1, 2]) expect(Math.abs(got.shown[i][c] - w[c]), `patch ${i}: ${got.shown[i].join()} vs ${w.join()}`).toBeLessThanOrEqual(3)
  expect(errors).toEqual([])
})

test('RAW keeps colors beyond sRGB through to Display P3 output', async ({ page }) => {
  const errors = await open(page)
  // wide.dng: a camera space of Rec. 2020; Rec. 2020 green at 40% on the left, then 40% gray, then a bright orange.
  await importFiles(page, 'wide.dng')
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const linearModule: string = '/src/engine/linear.ts'
    const colorModule: string = '/src/engine/color.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const { halfTable } = await import(/* @vite-ignore */ linearModule)
    const { apply, linearToSrgb, P3_TO_SRGB, SRGB_TO_P3, srgbToLinear } = await import(/* @vite-ignore */ colorModule)
    const pic = await r.decodeBlob(await (await fetch('/e2e/fixtures/wide.dng')).blob())
    const h = halfTable()
    const at = (x: number) => [0, 1, 2].map((c) => h[pic.data[(16 * pic.width + x) * 4 + c]])
    const ren = r.getRenderer()
    const px: Uint8ClampedArray = await ren.renderPixels(ren.loadSource(pic), defaultEdit(1), 96, 32, undefined, 0, 'display-p3')
    // The P3 render's green, back in linear sRGB.
    const p3 = Array.from(px.slice((16 * 96 + 10) * 4, (16 * 96 + 10) * 4 + 3)).map((v) => srgbToLinear(v / 255))
    // The orange as decoded, in encoded P3, against the render.
    const orange = apply(SRGB_TO_P3, at(80) as [number, number, number]).map((v: number) => Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, v)))))
    return {
      green: at(10),
      gray: at(50),
      p3InSrgb: apply(P3_TO_SRGB, p3 as [number, number, number]),
      orange: { decoded: at(80), want: orange, got: Array.from(px.slice((16 * 96 + 80) * 4, (16 * 96 + 80) * 4 + 3)) },
    }
  })
  // Rec. 2020 (0, 0.4, 0) in linear sRGB is (-0.235, 0.453, -0.040): the decode keeps the negative components.
  ;[-0.235, 0.4532, -0.0402].forEach((want, c) => expect(Math.abs(got.green[c] - want)).toBeLessThan(0.003))
  got.gray.forEach((v) => expect(Math.abs(v - 0.4)).toBeLessThan(0.002))
  // Display P3 output keeps it beyond sRGB as far as P3 reaches: P3 (0, 0.430, 0), whose red in linear sRGB is
  // -0.097 (an sRGB output would clip it to 0).
  expect(Math.abs(got.p3InSrgb[0] + 0.0968)).toBeLessThan(0.006)
  // The orange's red is above 1 in sRGB primaries but inside P3 (about 0.90): a color beyond sRGB, not light above
  // white, so an unedited P3 render keeps it as decoded.
  expect(got.orange.decoded[0]).toBeGreaterThan(1)
  for (const c of [0, 1, 2]) expect(Math.abs(got.orange.got[c] - got.orange.want[c]), `orange: ${got.orange.got.join()} vs ${got.orange.want.join()}`).toBeLessThanOrEqual(2)
  expect(errors).toEqual([])
})

test('Display P3 output does not step where an effect brightens a saturated color past white', async ({ page }) => {
  const errors = await open(page)
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const presetsModule: string = '/src/model/presets.ts'
    const linearModule: string = '/src/engine/linear.ts'
    const colorModule: string = '/src/engine/color.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const P = await import(/* @vite-ignore */ presetsModule)
    const { linearImage, toHalf } = await import(/* @vite-ignore */ linearModule)
    const { apply, P3_TO_SRGB } = await import(/* @vite-ignore */ colorModule)
    await P.loadAllSliders()
    const ren = r.getRenderer()
    const W = 512
    const H = 16
    // P3 green from black to full as a P3 photo, with Bloom; and as RAW from 0.1 to 4 times, with Bloom and Halation.
    const c = new OffscreenCanvas(W, H)
    const g = c.getContext('2d', { colorSpace: 'display-p3' })!
    for (let x = 0; x < W; x++) {
      g.fillStyle = `color(display-p3 0 ${x / (W - 1)} 0)`
      g.fillRect(x, 0, 1, H)
    }
    const green = apply(P3_TO_SRGB, [0, 1, 0])
    const data = new Uint16Array(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([...green.map((v: number) => v * 0.1 * 40 ** (x / (W - 1))), 1].map(toHalf), (y * W + x) * 4)
    const ramps = {
      photo: { src: ren.loadSource(c.transferToImageBitmap(), 'display-p3'), fx: { bloom: 1 } },
      raw: { src: ren.loadSource(linearImage(W, H, data)), fx: { bloom: 0.8, halation: 0.8 } },
    }
    const steps: Record<string, number> = {}
    for (const [name, ramp] of Object.entries(ramps))
      for (const look of [null, 'lb1', 'lb2', 'lb3', 'lb4']) {
        const e = defaultEdit(5)
        e.preset.id = look
        Object.assign(e.fx, ramp.fx)
        const px: Uint16Array = await ren.renderPixels16(ramp.src, e, W, H, undefined, 0, 'display-p3')
        let step = 0
        for (let x = 1; x < W; x++) for (let k = 0; k < 3; k++) step = Math.max(step, Math.abs(px[(8 * W + x) * 3 + k] - px[(8 * W + x - 1) * 3 + k]) / 65535)
        steps[`${name}/${look ?? 'none'}`] = step
      }
    return { steps, error: ren.gl.getError() }
  })
  expect(got.error).toBe(0)
  // Neighbouring pixels of these smooth ramps differ by at most 0.035 encoded; a color jumping where its luminance
  // crossed white differed by 0.22 to 0.39.
  for (const [k, v] of Object.entries(got.steps)) expect(v, k).toBeLessThan(0.06)
  expect(errors).toEqual([])
})

test('a Pro look between its captured states renders the same from the term cache as computed inline', async ({ page }) => {
  const errors = await open(page)
  const got = await page.evaluate(async () => {
    const editModule: string = '/src/model/edit.ts'
    const presetsModule: string = '/src/model/presets.ts'
    const paramsModule: string = '/src/engine/params.ts'
    const rendererModule: string = '/src/engine/renderer.ts'
    const lookModule: string = '/src/engine/look.ts'
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const P = await import(/* @vite-ignore */ presetsModule)
    const { buildRenderSpec } = await import(/* @vite-ignore */ paramsModule)
    const { Renderer } = await import(/* @vite-ignore */ rendererModule)
    const { identityPost } = await import(/* @vite-ignore */ lookModule)
    await P.loadAllSliders()
    // A synthetic Pro table on a renderer of its own: 32 states with a stage each and a state at zero, so eleven
    // terms take part at the setting below whatever the shipped catalog holds.
    const stages = Array.from({ length: 33 }, (_, k) => ({ ...identityPost(), sat: [0.02 * ((k % 7) + 1) * (k % 2 ? 1 : -1), 0, 0] }))
    const synthetic = { ...P.lookFor('lb1'), sliders: { kind: 'pro', stages } }
    const resolve = (id: string) => (id === 'synthetic-pro' ? synthetic : P.lookFor(id))
    const ren = Renderer.create(resolve)
    const W = 256
    const H = 64
    const c = new OffscreenCanvas(W, H)
    const g = c.getContext('2d')!
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        g.fillStyle = `hsl(${(x / W) * 360} ${30 + (y % 16) * 4.5}% ${8 + (y / H) * 84}%)`
        g.fillRect(x, y, 1, 1)
      }
    const src = ren.loadSource(c.transferToImageBitmap())
    const out: Record<string, { differs: number; terms: number; cached: number }> = {}
    // The synthetic table, with tools ahead of the look.
    for (const id of ['synthetic-pro']) {
      const at = (contrast: number) => {
        const e = defaultEdit(5)
        e.preset.id = id
        Object.assign(e.preset.dims, { contrast, color: 0.3, tone: -0.6 })
        Object.assign(e.tools, { exposure: 0.3, temperature: -0.2 })
        return e
      }
      // First seen: every term computed inline.
      const inline: Uint16Array = await ren.renderPixels16(src, at(0.7), W, H)
      // A drag inside the cell keeps the states, so the cache fills (two terms per bake) and is read.
      for (let i = 0; i < 8; i++) await ren.renderPixels16(src, at(i % 2 ? 0.7 : 0.72), W, H)
      const cached: Uint16Array = await ren.renderPixels16(src, at(0.7), W, H)
      let differs = 0
      for (let i = 0; i < inline.length; i++) if (inline[i] !== cached[i]) differs++
      const keys: string[] = buildRenderSpec(at(0.7), resolve).termKeys
      const slots = (ren as unknown as { termSlots: (string | null)[] }).termSlots
      out[id] = { differs, terms: keys.length, cached: keys.filter((k) => slots.includes(k)).length }
    }
    return { out, error: ren.gl.getError() }
  })
  expect(got.error).toBe(0)
  // Eleven states blend in the synthetic table, all read from the cache by the last render.
  expect(got.out['synthetic-pro'].terms).toBe(11)
  for (const [id, v] of Object.entries(got.out)) {
    // Every term that takes part was read from the cache, and the pixels are those computed inline.
    expect(v.cached, id).toBe(v.terms)
    expect(v.differs, id).toBe(0)
  }
  expect(errors).toEqual([])
})

test('an unedited color renders the same from a Display P3 bitmap and from linear light (RAW)', async ({ page }) => {
  const errors = await open(page)
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const linearModule: string = '/src/engine/linear.ts'
    const colorModule: string = '/src/engine/color.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const { linearImage, toHalf } = await import(/* @vite-ignore */ linearModule)
    const { apply, P3_TO_SRGB, srgbToLinear } = await import(/* @vite-ignore */ colorModule)
    // P3 primaries and secondaries (each has a component above 1 or below 0 in linear sRGB), then gray and white.
    const colors = [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1], [0.5, 0.5, 0.5], [1, 1, 1]]
    const W = colors.length * 16
    const H = 16
    const c = new OffscreenCanvas(W, H)
    const g = c.getContext('2d', { colorSpace: 'display-p3' })!
    colors.forEach(([R, G, B], i) => {
      g.fillStyle = `color(display-p3 ${R} ${G} ${B})`
      g.fillRect(i * 16, 0, 16, H)
    })
    // The same colors as linear light in sRGB primaries, from the canvas's own P3 values: what a RAW decode hands over.
    const p3 = g.getImageData(0, 0, W, H, { colorSpace: 'display-p3' }).data
    const data = new Uint16Array(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const lin = apply(P3_TO_SRGB, [0, 1, 2].map((k) => srgbToLinear(p3[i * 4 + k] / 255)) as [number, number, number])
      data.set([...lin, 1].map(toHalf), i * 4)
    }
    const ren = r.getRenderer()
    const sources = { bitmap: ren.loadSource(c.transferToImageBitmap(), 'display-p3'), linear: ren.loadSource(linearImage(W, H, data)) }
    const centers = (px: ArrayLike<number>, step: number) => colors.map((_, i) => Array.from({ length: 3 }, (_, k) => px[(8 * W + i * 16 + 8) * step + k]))
    const out: Record<string, Record<string, number[][]>> = {}
    for (const [name, src] of Object.entries(sources)) {
      const e = defaultEdit(1)
      out[name] = {
        p3: centers(await ren.renderPixels(src, e, W, H, undefined, 0, 'display-p3'), 4),
        p3_16: centers(await ren.renderPixels16(src, e, W, H, undefined, 0, 'display-p3'), 3),
        srgb: centers(await ren.renderPixels(src, e, W, H), 4),
      }
      ren.deleteSource(src)
    }
    return { out, error: ren.gl.getError() }
  })
  expect(got.error).toBe(0)
  // Within two 8-bit levels in every output (16-bit compared at the same tolerance: the bitmap holds 8-bit values).
  for (const [output, tol] of [['p3', 2], ['p3_16', 2 * 257], ['srgb', 2]] as const) {
    got.out.bitmap[output].forEach((want, i) => {
      for (const c of [0, 1, 2]) expect(Math.abs(got.out.linear[output][i][c] - want[c]), `${output} patch ${i}: ${got.out.linear[output][i].join()} vs ${want.join()}`).toBeLessThanOrEqual(tol)
    })
  }
  expect(errors).toEqual([])
})

test('RAW Exposure takes light above white back below it, level by level', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'wide.dng')
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const linearModule: string = '/src/engine/linear.ts'
    const colorModule: string = '/src/engine/color.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const { linearImage, toHalf } = await import(/* @vite-ignore */ linearModule)
    const { srgbToLinear } = await import(/* @vite-ignore */ colorModule)
    const ren = r.getRenderer()
    // Gray at 0.5, 1, 2 and 4 times white, as RAW light keeps it.
    const levels = [0.5, 1, 2, 4]
    const W = 64
    const H = 8
    const data = new Uint16Array(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const v = levels[Math.floor((i % W) / 16)]
      data.set([v, v, v, 1].map(toHalf), i * 4)
    }
    const ramp = ren.loadSource(linearImage(W, H, data))
    const row = async (tools: Record<string, number>) => {
      const e = defaultEdit(1)
      Object.assign(e.tools, tools)
      const px: Uint16Array = await ren.renderPixels16(ramp, e, W, H)
      return levels.map((_, i) => srgbToLinear(px[(4 * W + i * 16 + 8) * 3] / 65535))
    }
    // The orange of wide.dng: red above white in sRGB.
    const dng = ren.loadSource(await r.decodeBlob(await (await fetch('/e2e/fixtures/wide.dng')).blob()))
    const orange = async (rawExposure: number) => {
      const e = defaultEdit(1)
      e.tools.rawExposure = rawExposure
      const px: Uint16Array = await ren.renderPixels16(dng, e, 96, 32)
      return Array.from(px.slice((16 * 96 + 80) * 3, (16 * 96 + 80) * 3 + 3)).map((v) => srgbToLinear(v / 65535))
    }
    return {
      unedited: await row({}),
      // The fitted Exposure works on the picture as displayed: everything at or above white comes out the same.
      fitted: await row({ exposure: -0.5 }),
      // RAW Exposure is in stops, 3 at the end of the slider: -2 stops is a quarter of the light, before the clamp.
      raw: await row({ rawExposure: -2 / 3 }),
      orange: { unedited: await orange(0), down: await orange(-1 / 3) },
      error: ren.gl.getError(),
    }
  })
  expect(got.error).toBe(0)
  expect(got.unedited.slice(1).every((v) => v > 0.995)).toBe(true)
  expect(new Set(got.fitted.slice(1).map((v) => v.toFixed(4))).size).toBe(1)
  // A quarter of each level: 0.125, 0.25, 0.5 and 1.
  got.raw.forEach((v, i) => expect(Math.abs(v - [0.125, 0.25, 0.5, 1][i]), `level ${i}: ${v}`).toBeLessThan(0.003))
  // The orange one stop down keeps its true red to green ratio (about 3.83, against 3.68 clamped first).
  expect(got.orange.down[0]).toBeLessThan(0.6)
  expect(got.orange.down[0] / got.orange.down[1]).toBeGreaterThan(3.77)
  // The Tools panel offers it for a RAW photo.
  await page.getByRole('button', { name: 'Tools' }).click()
  await expect(page.getByRole('spinbutton', { name: 'RAW Exposure' })).toBeVisible()
  expect(errors).toEqual([])
})

test('RAW highlights: unedited they clamp at white as before, Highlights brings the clipped channel back', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'wide.dng')
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const colorModule: string = '/src/engine/color.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const { srgbToLinear } = await import(/* @vite-ignore */ colorModule)
    const ren = r.getRenderer()
    const src = ren.loadSource(await r.decodeBlob(await (await fetch('/e2e/fixtures/wide.dng')).blob()))
    // The orange region: linear sRGB about (1.04, 0.27, -0.05), its red above white. 16-bit output, so ratios hold.
    const orange = async (highlights: number) => {
      const e = defaultEdit(1)
      e.tools.highlights = highlights
      const px: Uint16Array = await ren.renderPixels16(src, e, 96, 32)
      return Array.from(px.slice((16 * 96 + 80) * 3, (16 * 96 + 80) * 3 + 3)).map((v) => srgbToLinear(v / 65535))
    }
    return { unedited: await orange(0), recovered: await orange(-1) }
  })
  // Unedited, red stops at white exactly as the camera rendering (and this app before) had it.
  expect(got.unedited[0]).toBeGreaterThan(0.995)
  // Pulled down, the red comes back in proportion: the true red to green ratio (about 3.83), not the clamped one (3.68).
  expect(got.recovered[0]).toBeLessThan(0.9)
  expect(got.recovered[0] / got.recovered[1]).toBeGreaterThan(3.77)
  expect(errors).toEqual([])
})

test('RAW keeps the decoder precision in the shadows', async ({ page }) => {
  const errors = await open(page)
  // ramp.dng: gray from black to linear 0.02 over 256 px; 8-bit sRGB holds that in only 41 levels.
  await importFiles(page, 'ramp.dng')
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const pic = await r.decodeBlob(await (await fetch('/e2e/fixtures/ramp.dng')).blob())
    const levels = new Set<number>()
    if ('linear' in pic) for (let x = 0; x < pic.width; x++) levels.add(pic.data[x * 4])
    const out = r.getRenderer().renderBitmap(r.gpuSource('ramp-test', pic), defaultEdit(), 256, 32)
    const g = new OffscreenCanvas(256, 32).getContext('2d')!
    g.drawImage(out, 0, 0)
    const row = Array.from(g.getImageData(0, 16, 256, 1).data.filter((_, i) => i % 4 === 0))
    return { linear: 'linear' in pic, levels: levels.size, row }
  })
  expect(got.linear).toBe(true)
  expect(got.levels).toBeGreaterThan(200)
  // Unedited, the GPU render is the ramp itself in sRGB (the renderer dithers by one level).
  const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
  got.row.forEach((v, x) => expect(Math.abs(v - 255 * srgb((0.02 * x) / 255)), `x ${x}`).toBeLessThanOrEqual(2))
  expect(errors).toEqual([])
})

test('16-bit export keeps the shadows a 8-bit file rounds away', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'ramp.dng')
  // Through the renderer: the ramp's 256 pixels stay 256 values at 16 bits; 8 bits hold about 41 plus dither.
  const counts = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const ren = r.getRenderer()
    const src = ren.loadSource(await r.decodeBlob(await (await fetch('/e2e/fixtures/ramp.dng')).blob()))
    const e = defaultEdit(1)
    const p16: Uint16Array = await ren.renderPixels16(src, e, 256, 32)
    const p8: Uint8ClampedArray = await ren.renderPixels(src, e, 256, 32)
    const row16 = new Set(Array.from({ length: 256 }, (_, x) => p16[(16 * 256 + x) * 3]))
    const row8 = new Set(Array.from({ length: 256 }, (_, x) => p8[(16 * 256 + x) * 4]))
    return [row16.size, row8.size, p16[(16 * 256 + 255) * 3]]
  })
  expect(counts[0]).toBeGreaterThan(240)
  expect(counts[1]).toBeLessThan(80)
  // The brightest pixel is linear 0.02, sRGB 0.1517: 9942 of 65535 (LibRaw rounds it to 0.01994, 9926).
  expect(Math.abs(counts[2] - 9942)).toBeLessThan(40)

  // The panel exports a TIFF and a 16-bit PNG; the page keeps each blob it hands to a download.
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob | MediaSource) => (((window as unknown as { __out: unknown }).__out = b), create(b))
  })
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const header = () =>
    page.evaluate(async () => {
      const b = new Uint8Array(await (window as unknown as { __out: Blob }).__out.arrayBuffer())
      const v = new DataView(b.buffer)
      if (b[0] === 0x49) {
        // TIFF: the first IFD's width and height (both LONG, inline).
        const ifd = v.getUint32(4, true)
        const tag = (t: number) => {
          for (let i = 0; i < v.getUint16(ifd, true); i++) if (v.getUint16(ifd + 2 + i * 12, true) === t) return v.getUint32(ifd + 10 + i * 12, true)
          return -1
        }
        return ['tiff', tag(256), tag(257), tag(34675) > 0 ? 1 : 0]
      }
      return ['png', v.getUint32(16), v.getUint32(20), b[24]]
    })
  await page.getByRole('button', { name: 'TIFF' }).click()
  let download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 1 photo' }).click()
  expect((await download).suggestedFilename()).toMatch(/^ramp_edit\.tif$/)
  expect(await header()).toEqual(['tiff', 256, 32, 1])
  await page.getByRole('button', { name: 'PNG' }).click()
  await page.getByRole('button', { name: '16-bit' }).click()
  download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 1 photo' }).click()
  expect((await download).suggestedFilename()).toMatch(/^ramp_edit\.png$/)
  expect(await header()).toEqual(['png', 256, 32, 16])
  expect(errors).toEqual([])
})

test('RAW imports through the bundled decoder', async ({ page }) => {
  const errors = await open(page)
  // chart.dng: linear RGB with an sRGB color matrix and no preview, so it must decode to the chart's own colors.
  await importFiles(page, 'chart.dng')
  const px = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const bmp = await r.drawable(await r.decodeBlob(await (await fetch('/e2e/fixtures/chart.dng')).blob()))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    return [bmp.width, bmp.height, ...g.getImageData(15, 15, 1, 1).data.slice(0, 3), ...g.getImageData(44, 50, 1, 1).data.slice(0, 3)]
  })
  expect(px.slice(0, 2)).toEqual([96, 64])
  for (const [got, want] of px.slice(2).map((v, i) => [v, [200, 40, 40, 40, 40, 40][i]])) expect(Math.abs(got - want)).toBeLessThanOrEqual(2)
  await page.getByRole('button', { name: 'Info' }).click()
  await expect(page.getByText('Imaginary Test DNG')).toBeVisible()
  await expect(page.getByText('DNG', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

