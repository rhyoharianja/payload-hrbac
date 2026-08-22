import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { payloadRbac } from 'payload-rbac'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

/**
 * Test bed plugin. Sengaja memakai bentuk field yang berlapis (group, tab, array,
 * blocks) karena di situlah aturan path izin field paling mudah salah.
 */
export default buildConfig({
  admin: {
    importMap: { baseDir: path.resolve(dirname) },
    user: 'users',
  },
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        // Field rahasia: dipakai menguji bahwa peran tertentu tidak bisa
        // membacanya walau boleh membaca dokumennya.
        { name: 'internalNotes', type: 'textarea' },
        {
          name: 'hero',
          type: 'group',
          fields: [
            { name: 'heading', type: 'text' },
            { name: 'subheading', type: 'text' },
          ],
        },
        {
          name: 'links',
          type: 'array',
          fields: [
            { name: 'label', type: 'text' },
            { name: 'url', type: 'text' },
          ],
        },
        {
          type: 'tabs',
          tabs: [
            {
              name: 'seo',
              fields: [{ name: 'metaTitle', type: 'text' }],
              label: 'SEO',
            },
            {
              fields: [{ name: 'unnamedTabField', type: 'text' }],
              label: 'Lainnya',
            },
          ],
        },
        {
          name: 'layout',
          type: 'blocks',
          blocks: [
            {
              slug: 'cta',
              fields: [
                { name: 'heading', type: 'text' },
                { name: 'buttonLabel', type: 'text' },
              ],
            },
          ],
        },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'media',
      fields: [],
      upload: { staticDir: path.resolve(dirname, 'media') },
    },
  ],
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URI || 'file::memory:?cache=shared' },
  }),
  editor: lexicalEditor(),
  email: testEmailAdapter,
  globals: [
    {
      slug: 'site-settings',
      fields: [
        { name: 'siteName', type: 'text' },
        { name: 'analyticsId', type: 'text' },
      ],
    },
  ],
  onInit: async (payload) => {
    await seed(payload)
  },
  plugins: [
    payloadRbac({
      entityLabels: { posts: 'Artikel', 'site-settings': 'Pengaturan Situs' },
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'test-secret_key',
  sharp,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
