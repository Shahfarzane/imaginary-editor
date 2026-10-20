import { defineConfig } from 'cf/config'

// Deploys the built app as a Worker that only serves static assets, on the account's workers.dev subdomain.
export default defineConfig({
  worker: {
    name: 'imaginary-editor',
    compatibilityDate: '2026-10-01',
  },
})
