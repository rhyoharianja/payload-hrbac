import type { Field } from 'payload'

import { describe, expect, test } from 'vitest'

import type { RoleDoc } from '../src/core/matrix.js'

import { collectFieldPaths, entityKey, fieldKey } from '../src/core/fieldPaths.js'
import {
  collectionPermissionFor,
  fieldPermissionFor,
  globalPermissionFor,
  mergeRoles,
  resolveAssignedRoles,
} from '../src/core/matrix.js'

const roleMap = (roles: RoleDoc[]) => new Map(roles.map((r) => [String(r.id), r]))

const resolve = (roles: RoleDoc[], startIds: (number | string)[]) =>
  mergeRoles(resolveAssignedRoles(startIds, roleMap(roles)))

describe('penggabungan peran (aditif / OR)', () => {
  test('dua peran digabung, yang paling longgar menang', () => {
    const matrix = resolve(
      [
        { id: 1, slug: 'a', collectionPermissions: [{ collection: 'posts', read: true }] },
        { id: 2, slug: 'b', collectionPermissions: [{ collection: 'posts', update: true }] },
      ],
      [1, 2],
    )

    expect(collectionPermissionFor(matrix, 'posts')).toMatchObject({
      create: false,
      delete: false,
      read: true,
      update: true,
    })
    expect(matrix.roleSlugs).toEqual(['a', 'b'])
  })

  test('collection tanpa baris izin = tertutup (default deny)', () => {
    const matrix = resolve([{ id: 1, collectionPermissions: [{ collection: 'posts', read: true }] }], [1])
    expect(collectionPermissionFor(matrix, 'media').read).toBe(false)
  })

  test('super admin mengabaikan seluruh centang', () => {
    const matrix = resolve([{ id: 1, isSuperAdmin: true }], [1])
    expect(collectionPermissionFor(matrix, 'apa-pun')).toMatchObject({ delete: true, read: true })
    expect(globalPermissionFor(matrix, 'apa-pun').update).toBe(true)
    expect(matrix.canAccessAdmin).toBe(true)
  })
})

describe('pewarisan peran berlapis', () => {
  const roles: RoleDoc[] = [
    { id: 1, slug: 'base', collectionPermissions: [{ collection: 'posts', read: true }] },
    {
      id: 2,
      slug: 'editor',
      collectionPermissions: [{ collection: 'posts', update: true }],
      parent: 1,
    },
    {
      id: 3,
      slug: 'lead',
      collectionPermissions: [{ collection: 'posts', delete: true }],
      parent: 2,
    },
  ]

  test('cucu mewarisi izin kakek', () => {
    const matrix = resolve(roles, [3])
    expect(collectionPermissionFor(matrix, 'posts')).toMatchObject({
      delete: true,
      read: true,
      update: true,
    })
    expect(matrix.roleSlugs.sort()).toEqual(['base', 'editor', 'lead'])
  })

  test('induk tidak mewarisi izin anak', () => {
    const matrix = resolve(roles, [1])
    expect(collectionPermissionFor(matrix, 'posts')).toMatchObject({
      delete: false,
      read: true,
      update: false,
    })
  })

  test('rantai melingkar tidak menggantung', () => {
    const cyclic: RoleDoc[] = [
      { id: 1, collectionPermissions: [{ collection: 'posts', read: true }], parent: 2 },
      { id: 2, collectionPermissions: [{ collection: 'posts', update: true }], parent: 1 },
    ]
    const matrix = resolve(cyclic, [1])
    expect(collectionPermissionFor(matrix, 'posts')).toMatchObject({ read: true, update: true })
  })
})

describe('izin field', () => {
  const entity = entityKey('collection', 'posts')
  const notes = fieldKey('collection', 'posts', 'internalNotes')
  const title = fieldKey('collection', 'posts', 'title')

  test('field yang tidak diatur mengikuti izin collection (default izinkan)', () => {
    const matrix = resolve([{ id: 1, collectionPermissions: [{ collection: 'posts', read: true }] }], [1])
    expect(fieldPermissionFor(matrix, entity, title)).toMatchObject({ read: true, update: true })
  })

  test('baris tanpa centang menutup field itu saja', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true, update: true }],
          fieldPermissions: [{ create: false, read: false, target: notes, update: false }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(false)
    expect(fieldPermissionFor(matrix, entity, title).read).toBe(true)
  })

  test('penolakan satu peran TIDAK menular ke peran lain yang tidak membatasi', () => {
    // Inti aturan OR: peran B tidak pernah berpendapat soal internalNotes,
    // jadi larangan milik peran A tidak boleh ikut mengikat user ini.
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
        { id: 2, collectionPermissions: [{ collection: 'posts', read: true }] },
      ],
      [1, 2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(true)
  })

  test('penolakan berlaku bila SEMUA peran menolak', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
        {
          id: 2,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
      ],
      [1, 2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(false)
  })

  test('peran tanpa izin apa pun di collection itu tidak ikut membuka field', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
        { id: 2, collectionPermissions: [{ collection: 'media', read: true }] },
      ],
      [1, 2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(false)
  })

  test('allowlist: hanya field terdaftar yang boleh', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true, update: true }],
          fieldPermissions: [{ read: true, target: title, update: true }],
          fieldPolicies: [{ entity, policy: 'allowlist' }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, title).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })

  test('allowlist tidak mengunci collection lain', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            { collection: 'posts', read: true },
            { collection: 'media', read: true, update: true },
          ],
          fieldPermissions: [{ read: true, target: title }],
          fieldPolicies: [{ entity, policy: 'allowlist' }],
        },
      ],
      [1],
    )
    const mediaEntity = entityKey('collection', 'media')
    expect(fieldPermissionFor(matrix, mediaEntity, fieldKey('collection', 'media', 'alt')).update).toBe(
      true,
    )
  })

  test('aturan field ikut diwarisi dari induk', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
        { id: 2, parent: 1 },
      ],
      [2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(false)
  })

  test('super admin melewati seluruh aturan field', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
        { id: 2, isSuperAdmin: true },
      ],
      [1, 2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(true)
  })
})

describe('penelusuran path field', () => {
  const fields: Field[] = [
    { name: 'title', type: 'text' },
    { name: 'hero', type: 'group', fields: [{ name: 'heading', type: 'text' }] },
    { name: 'links', type: 'array', fields: [{ name: 'label', type: 'text' }] },
    {
      type: 'row',
      fields: [{ name: 'inRow', type: 'text' }],
    },
    {
      type: 'tabs',
      tabs: [
        { name: 'seo', fields: [{ name: 'metaTitle', type: 'text' }], label: 'SEO' },
        { fields: [{ name: 'loose', type: 'text' }], label: 'Lainnya' },
      ],
    },
    {
      name: 'layout',
      type: 'blocks',
      blocks: [{ slug: 'cta', fields: [{ name: 'heading', type: 'text' }] }],
    },
    { name: 'someUi', type: 'ui', admin: { components: {} } },
  ]

  const paths = collectFieldPaths(fields).map((f) => f.path)

  test('menurunkan path bertitik untuk setiap wadah', () => {
    expect(paths).toContain('title')
    expect(paths).toContain('hero.heading')
    expect(paths).toContain('links.label')
    expect(paths).toContain('seo.metaTitle')
    expect(paths).toContain('layout.cta.heading')
  })

  test('wadah tanpa nama bersifat transparan', () => {
    // `row` dan tab tanpa nama tidak menambah segmen path.
    expect(paths).toContain('inRow')
    expect(paths).toContain('loose')
  })

  test('field presentasional tidak muncul', () => {
    expect(paths).not.toContain('someUi')
    expect(paths.some((p) => p.startsWith('id'))).toBe(false)
  })

  test('wadah bernama tetap bisa diberi izin sendiri', () => {
    expect(paths).toContain('hero')
    expect(paths).toContain('links')
  })
})

describe('pewarisan bisa mempersempit, peran terpisah tidak', () => {
  const entity = entityKey('collection', 'posts')
  const notes = fieldKey('collection', 'posts', 'internalNotes')
  const heading = fieldKey('collection', 'posts', 'hero.heading')
  const hero = fieldKey('collection', 'posts', 'hero')

  test('turunan menutup field yang induknya biarkan terbuka', () => {
    // Ini bedanya pewarisan dengan memegang dua peran: turunan ADALAH induknya
    // plus penyesuaian, jadi penyempitan olehnya harus benar-benar berlaku.
    const matrix = resolve(
      [
        { id: 1, slug: 'base', collectionPermissions: [{ collection: 'posts', read: true }] },
        {
          id: 2,
          slug: 'child',
          fieldPermissions: [{ read: false, target: notes }],
          parent: 1,
        },
      ],
      [2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(false)
    expect(collectionPermissionFor(matrix, 'posts').read).toBe(true)
  })

  test('turunan boleh membuka kembali field yang ditutup induknya', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [{ read: false, target: notes }],
        },
        { id: 2, fieldPermissions: [{ read: true, target: notes }], parent: 1 },
      ],
      [2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(true)
  })

  test('allowlist: wadah induk ikut terbuka bila anaknya terdaftar', () => {
    // Tanpa ini, mendaftarkan `hero.heading` tidak pernah berpengaruh: Payload
    // membuang seluruh group `hero` sebelum sampai ke anaknya.
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true, update: true }],
          fieldPermissions: [{ create: true, read: true, target: heading, update: true }],
          fieldPolicies: [{ entity, policy: 'allowlist' }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, hero).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, heading).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })
})

describe('tingkat akses field (satu pilihan, bukan tiga centang)', () => {
  const entity = entityKey('collection', 'posts')
  const notes = fieldKey('collection', 'posts', 'internalNotes')
  const title = fieldKey('collection', 'posts', 'title')

  const withField = (target: string, access: 'edit' | 'hidden' | 'readonly'): RoleDoc[] => [
    {
      id: 1,
      collectionPermissions: [
        { collection: 'posts', create: true, read: true, update: true },
      ],
      fieldPermissions: [{ access, target }],
    },
  ]

  test('"boleh ubah" = terlihat dan bisa diisi', () => {
    const matrix = resolve(withField(notes, 'edit'), [1])
    expect(fieldPermissionFor(matrix, entity, notes)).toEqual({
      create: true,
      read: true,
      update: true,
    })
  })

  test('"hanya baca" = terlihat, tapi tidak bisa diisi', () => {
    // Inilah yang membuat Payload merender field-nya read-only, bukan
    // menghilangkannya: read tetap true, create/update false.
    const matrix = resolve(withField(notes, 'readonly'), [1])
    expect(fieldPermissionFor(matrix, entity, notes)).toEqual({
      create: false,
      read: true,
      update: false,
    })
  })

  test('"tersembunyi" = tidak dirender sama sekali', () => {
    const matrix = resolve(withField(notes, 'hidden'), [1])
    expect(fieldPermissionFor(matrix, entity, notes)).toEqual({
      create: false,
      read: false,
      update: false,
    })
  })

  test('field lain tidak ikut terpengaruh', () => {
    const matrix = resolve(withField(notes, 'hidden'), [1])
    expect(fieldPermissionFor(matrix, entity, title)).toEqual({
      create: true,
      read: true,
      update: true,
    })
  })

  test('access menang atas boolean lama bila keduanya ada', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          // Baris hasil migrasi bisa membawa keduanya; yang baru yang berlaku.
          fieldPermissions: [
            { access: 'readonly', create: true, read: true, target: notes, update: true },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })

  test('access tidak dikenal jatuh ke boolean lama, bukan menutup field', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true }],
          fieldPermissions: [
            { access: 'entah-apa' as never, read: true, target: notes, update: true },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes)).toMatchObject({ read: true, update: true })
  })
})

describe('kebijakan field menempel pada baris collection', () => {
  const entity = entityKey('collection', 'posts')
  const notes = fieldKey('collection', 'posts', 'internalNotes')
  const title = fieldKey('collection', 'posts', 'title')

  test('allowlist pada baris collection mengunci field yang tidak didaftarkan', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            { collection: 'posts', fieldPolicy: 'allowlist', read: true, update: true },
          ],
          fieldPermissions: [{ access: 'edit', target: title }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, title).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })

  test('restrict (bawaan) membiarkan field yang tidak didaftarkan terbuka', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            { collection: 'posts', fieldPolicy: 'restrict', read: true, update: true },
          ],
          fieldPermissions: [{ access: 'hidden', target: notes }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, title).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, notes).read).toBe(false)
  })

  test('kebijakan pada baris global juga berlaku', () => {
    const globalEntity = entityKey('global', 'site-settings')
    const analytics = fieldKey('global', 'site-settings', 'analyticsId')
    const siteName = fieldKey('global', 'site-settings', 'siteName')

    const matrix = resolve(
      [
        {
          id: 1,
          fieldPermissions: [{ access: 'edit', target: siteName }],
          globalPermissions: [
            { fieldPolicy: 'allowlist', global: 'site-settings', read: true, update: true },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, globalEntity, siteName).update).toBe(true)
    expect(fieldPermissionFor(matrix, globalEntity, analytics).update).toBe(false)
  })

  test('bentuk lama (array kebijakan terpisah) masih dihormati', () => {
    // Peran yang tersimpan sebelum perubahan ini tidak boleh berubah arti.
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true, update: true }],
          fieldPermissions: [{ access: 'edit', target: title }],
          fieldPolicies: [{ entity, policy: 'allowlist' }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })

  test('kebijakan pada baris menang atas bentuk lama', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            { collection: 'posts', fieldPolicy: 'restrict', read: true, update: true },
          ],
          fieldPolicies: [{ entity, policy: 'allowlist' }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(true)
  })
})

describe('akses field diatur di dalam baris entitasnya', () => {
  const entity = entityKey('collection', 'posts')
  const notes = fieldKey('collection', 'posts', 'internalNotes')
  const title = fieldKey('collection', 'posts', 'title')
  const heading = fieldKey('collection', 'posts', 'hero.heading')

  test('peta path → tingkat akses dibaca dari baris collection', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            {
              collection: 'posts',
              fieldAccess: { 'hero.heading': 'hidden', internalNotes: 'readonly' },
              read: true,
              update: true,
            },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes)).toEqual({
      create: false,
      read: true,
      update: false,
    })
    expect(fieldPermissionFor(matrix, entity, heading).read).toBe(false)
    // Yang tidak disebut mengikuti izin collection.
    expect(fieldPermissionFor(matrix, entity, title).update).toBe(true)
  })

  test('peta pada baris global juga dibaca', () => {
    const globalEntity = entityKey('global', 'site-settings')
    const analytics = fieldKey('global', 'site-settings', 'analyticsId')
    const matrix = resolve(
      [
        {
          id: 1,
          globalPermissions: [
            {
              fieldAccess: { analyticsId: 'hidden' },
              global: 'site-settings',
              read: true,
              update: true,
            },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, globalEntity, analytics).read).toBe(false)
  })

  test('tingkat akses tidak dikenal diabaikan, bukan menutup field', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            {
              collection: 'posts',
              fieldAccess: { internalNotes: 'entah-apa' as never },
              read: true,
              update: true,
            },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(true)
  })

  test('pewarisan menggabung PER PATH, bukan mengganti seluruh peta', () => {
    // Turunan hanya menyebut satu field; batasan induk pada field lain harus
    // tetap berlaku, bukan ikut terhapus.
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            {
              collection: 'posts',
              fieldAccess: { 'hero.heading': 'hidden', internalNotes: 'hidden' },
              read: true,
            },
          ],
        },
        {
          id: 2,
          collectionPermissions: [
            { collection: 'posts', fieldAccess: { internalNotes: 'edit' }, update: true },
          ],
          parent: 1,
        },
      ],
      [2],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, heading).read).toBe(false)
  })

  test('bentuk lama (array datar) masih dibaca', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [{ collection: 'posts', read: true, update: true }],
          fieldPermissions: [{ access: 'readonly', target: notes }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })

  test('peta pada baris menang atas array datar bentuk lama', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            { collection: 'posts', fieldAccess: { internalNotes: 'edit' }, read: true, update: true },
          ],
          fieldPermissions: [{ access: 'hidden', target: notes }],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(true)
  })

  test('allowlist tetap berlaku bersama peta', () => {
    const matrix = resolve(
      [
        {
          id: 1,
          collectionPermissions: [
            {
              collection: 'posts',
              fieldAccess: { title: 'edit' },
              fieldPolicy: 'allowlist',
              read: true,
              update: true,
            },
          ],
        },
      ],
      [1],
    )
    expect(fieldPermissionFor(matrix, entity, title).update).toBe(true)
    expect(fieldPermissionFor(matrix, entity, notes).update).toBe(false)
  })
})
