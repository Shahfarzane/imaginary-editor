import { expect, type Page } from '@playwright/test'

/** Open the app on an empty library; collects page errors and console errors for the test to check. */
export async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto('/')
  await expect(page.getByText('Add your photos')).toBeVisible()
  return errors
}

/** Import fixtures through the file chooser and wait until every one is in. */
export async function importFiles(page: Page, ...files: string[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Add images' }).click()
  await (await chooser).setFiles(files.map((f) => `e2e/fixtures/${f}`))
  // An import selects its photos once every file is in; the toolbar counts them.
  await expect(page.getByText(`${files.length} selected`, { exact: true })).toBeVisible({ timeout: 20_000 })
}
