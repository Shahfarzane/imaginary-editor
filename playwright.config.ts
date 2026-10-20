import { defineConfig, devices } from '@playwright/test'

// Browser smoke tests (e2e/): the real app in Chromium and WebKit, on a dev server of their own so
// they never touch your library or a server someone is using.
const GPU_LOSS = /gpu-loss\.spec\.ts/
const viewport = { width: 1440, height: 900 }
// On the Mac's GPU (Metal through ANGLE), like a real browser: the default software WebGL (SwiftShader) died
// after about eight JPEG plus HEIC imports in one browser, a crash the GPU path never showed. The full Chromium build
// (channel 'chromium', new headless mode), not the headless shell: macOS (loginwindow) force-quits the shell, a
// windowless process with no app bundle, while tests run in parallel (4 of 80 tests at --repeat-each=4, every run,
// with a force quit logged for each browser); the full build ran 160 of 160 with none.
const chromium = (name: string, files: object) => ({
  name,
  ...files,
  use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport, launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } },
})
const webkit = (name: string, files: object) => ({ name, ...files, use: { ...devices['Desktop Safari'], viewport } })

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5399', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'bunx vp dev --port 5399 --strictPort', url: 'http://localhost:5399', reuseExistingServer: false },
  // Tests that lose the GPU context on purpose (gpu-loss.spec.ts) get projects, so browser instances, of their own.
  projects: [chromium('chromium', { testIgnore: GPU_LOSS }), webkit('webkit', { testIgnore: GPU_LOSS }), chromium('chromium-gpu-loss', { testMatch: GPU_LOSS }), webkit('webkit-gpu-loss', { testMatch: GPU_LOSS })],
})
