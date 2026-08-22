import type { Payload, TypedUser } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { entityKey, fieldKey } from '../src/core/fieldPaths.js'

/**
 * Uji integrasi: memastikan matriks izin benar-benar TERPASANG ke Payload,
 * bukan sekadar benar secara logika (itu urusan rbac.unit.spec.ts).
 *
 * Semua operasi memakai `overrideAccess: false` + `user`, karena tanpa itu
 * Local API melewati seluruh access control dan tesnya jadi tidak berarti.
 */

let payload: Payload

const POSTS = entityKey('collection', 'posts')
const NOTES = fieldKey('collection', 'posts', 'internalNotes')
const HERO_HEADING = fieldKey('collection', 'posts', 'hero.heading')
const CTA_HEADING = fieldKey('collection', 'posts', 'layout.cta.heading')

const asUser = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })
  return { ...docs[0], collection: 'users' } as unknown as TypedUser
}

const createRole = async (data: Record<string, unknown>) =>
  payload.create({ collection: 'roles' as never, data: data as never, overrideAccess: true })

const createUser = async (email: string, roles: unknown[]) =>
  payload.create({
    collection: 'users',
    data: { email, password: 'Test12345!', roles } as never,
    overrideAccess: true,
  })

let postId: number | string

beforeAll(async () => {
  payload = await getPayload({ config })

  const readerRole = await createRole({
    name: 'Reader',
    slug: 'reader',
    canAccessAdmin: true,
    collectionPermissions: [{ collection: 'posts', read: true }],
  })

  // Mewarisi Reader lalu menambah update — sekaligus menutup satu field.
  const editorRole = await createRole({
    name: 'Editor',
    slug: 'editor',
    canAccessAdmin: true,
    collectionPermissions: [
      { collection: 'posts', fieldAccess: { internalNotes: 'hidden' }, update: true },
    ],
    parent: readerRole.id,
  })

  const adminRole = await createRole({
    name: 'Root',
    slug: 'root',
    canAccessAdmin: true,
    isSuperAdmin: true,
  })

  // Hanya boleh menyentuh hero.heading di posts, tidak yang lain.
  const heroOnlyRole = await createRole({
    name: 'Hero Only',
    slug: 'hero-only',
    canAccessAdmin: true,
    collectionPermissions: [
      {
        collection: 'posts',
        fieldAccess: { 'hero.heading': 'edit' },
        fieldPolicy: 'allowlist',
        read: true,
        update: true,
      },
    ],
  })

  const noAdminRole = await createRole({
    name: 'API Only',
    slug: 'api-only',
    canAccessAdmin: false,
    collectionPermissions: [{ collection: 'posts', read: true }],
  })

  await createUser('reader@test.local', [readerRole.id])
  await createUser('editor@test.local', [editorRole.id])
  await createUser('root@test.local', [adminRole.id])
  await createUser('hero@test.local', [heroOnlyRole.id])
  await createUser('noadmin@test.local', [noAdminRole.id])
  await createUser('norole@test.local', [])

  const post = await payload.create({
    collection: 'posts',
    data: {
      hero: { heading: 'Hero awal', subheading: 'Sub awal' },
      internalNotes: 'rahasia',
      layout: [{ blockType: 'cta', buttonLabel: 'Klik', heading: 'CTA awal' }],
      title: 'Judul awal',
    } as never,
    overrideAccess: true,
  })
  postId = post.id
})

afterAll(async () => {
  await payload.destroy()
})

describe('pemasangan plugin', () => {
  test('collection roles dibuat dan field peran ditambahkan ke users', () => {
    expect(payload.collections.roles).toBeDefined()
    const userFields = payload.collections.users.config.fields as { name?: string }[]
    expect(userFields.some((f) => f.name === 'roles')).toBe(true)
  })
})

describe('izin collection', () => {
  test('reader boleh membaca', async () => {
    const { docs } = await payload.find({
      collection: 'posts',
      overrideAccess: false,
      user: await asUser('reader@test.local'),
    })
    expect(docs.length).toBeGreaterThan(0)
  })

  test('reader tidak boleh mengubah', async () => {
    await expect(
      payload.update({
        id: postId,
        collection: 'posts',
        data: { title: 'diubah reader' },
        overrideAccess: false,
        user: await asUser('reader@test.local'),
      }),
    ).rejects.toThrow()
  })

  test('user tanpa peran tidak bisa membaca apa pun', async () => {
    await expect(
      payload.find({
        collection: 'posts',
        overrideAccess: false,
        user: await asUser('norole@test.local'),
      }),
    ).rejects.toThrow()
  })

  test('editor mewarisi read dari induknya dan menambah update', async () => {
    const user = await asUser('editor@test.local')
    const { docs } = await payload.find({ collection: 'posts', overrideAccess: false, user })
    expect(docs.length).toBeGreaterThan(0)

    const updated = await payload.update({
      id: postId,
      collection: 'posts',
      data: { title: 'diubah editor' },
      overrideAccess: false,
      user,
    })
    expect(updated.title).toBe('diubah editor')
  })

  test('collection yang tidak diberi izin tetap tertutup', async () => {
    await expect(
      payload.find({
        collection: 'media',
        overrideAccess: false,
        user: await asUser('editor@test.local'),
      }),
    ).rejects.toThrow()
  })
})

describe('izin field', () => {
  test('field yang ditolak hilang dari hasil baca', async () => {
    const doc = await payload.findByID({
      id: postId,
      collection: 'posts',
      overrideAccess: false,
      user: await asUser('editor@test.local'),
    })
    expect(doc.title).toBeDefined()
    expect((doc as Record<string, unknown>).internalNotes).toBeUndefined()
  })

  test('field yang diizinkan tetap terbaca oleh peran lain', async () => {
    const doc = await payload.findByID({
      id: postId,
      collection: 'posts',
      overrideAccess: false,
      user: await asUser('reader@test.local'),
    })
    expect((doc as Record<string, unknown>).internalNotes).toBe('rahasia')
  })

  test('perubahan pada field yang ditolak diabaikan, sisanya tetap tersimpan', async () => {
    const user = await asUser('editor@test.local')
    await payload.update({
      id: postId,
      collection: 'posts',
      data: { internalNotes: 'diubah diam-diam', title: 'judul baru' } as never,
      overrideAccess: false,
      user,
    })

    const fresh = await payload.findByID({ id: postId, collection: 'posts', overrideAccess: true })
    expect(fresh.title).toBe('judul baru')
    expect((fresh as Record<string, unknown>).internalNotes).toBe('rahasia')
  })

  test('allowlist: field bersarang di dalam group boleh diubah', async () => {
    const user = await asUser('hero@test.local')
    await payload.update({
      id: postId,
      collection: 'posts',
      data: { hero: { heading: 'Hero baru' } } as never,
      overrideAccess: false,
      user,
    })

    const fresh = await payload.findByID({ id: postId, collection: 'posts', overrideAccess: true })
    expect((fresh as Record<string, never>).hero.heading).toBe('Hero baru')
  })

  test('allowlist: field di luar daftar tidak berubah', async () => {
    const before = await payload.findByID({ id: postId, collection: 'posts', overrideAccess: true })
    const user = await asUser('hero@test.local')

    await payload.update({
      id: postId,
      collection: 'posts',
      data: { title: 'coba tembus allowlist' } as never,
      overrideAccess: false,
      user,
    })

    const after = await payload.findByID({ id: postId, collection: 'posts', overrideAccess: true })
    expect(after.title).toBe(before.title)
  })

  test('field di dalam blocks ikut ditegakkan', async () => {
    const user = await asUser('hero@test.local')
    const before = await payload.findByID({ id: postId, collection: 'posts', overrideAccess: true })
    const beforeHeading = (before as Record<string, never>).layout[0].heading

    await payload.update({
      id: postId,
      collection: 'posts',
      data: {
        layout: [{ blockType: 'cta', buttonLabel: 'X', heading: 'CTA ditembus' }],
      } as never,
      overrideAccess: false,
      user,
    })

    const after = await payload.findByID({ id: postId, collection: 'posts', overrideAccess: true })
    expect((after as Record<string, never>).layout[0].heading).toBe(beforeHeading)
    expect(CTA_HEADING).toBe('collection:posts:layout.cta.heading')
  })

  test('super admin melewati seluruh pembatasan field', async () => {
    const user = await asUser('root@test.local')
    const doc = await payload.findByID({
      id: postId,
      collection: 'posts',
      overrideAccess: false,
      user,
    })
    expect((doc as Record<string, unknown>).internalNotes).toBe('rahasia')
  })
})

describe('izin global', () => {
  test('global tanpa izin tertutup, dengan izin terbuka', async () => {
    const editor = await asUser('editor@test.local')
    await expect(
      payload.findGlobal({ slug: 'site-settings' as never, overrideAccess: false, user: editor }),
    ).rejects.toThrow()

    const role = await payload.find({
      collection: 'roles' as never,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: 'editor' } },
    })
    await payload.update({
      id: role.docs[0].id,
      collection: 'roles' as never,
      data: { globalPermissions: [{ global: 'site-settings', read: true }] } as never,
      overrideAccess: true,
    })

    const doc = await payload.findGlobal({
      slug: 'site-settings' as never,
      overrideAccess: false,
      user: await asUser('editor@test.local'),
    })
    expect(doc).toBeDefined()
  })
})

describe('pengaman', () => {
  test('peran super admin terakhir tidak bisa dihapus', async () => {
    const { docs } = await payload.find({
      collection: 'roles' as never,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: 'root' } },
    })
    await expect(
      payload.delete({ id: docs[0].id, collection: 'roles' as never, overrideAccess: true }),
    ).rejects.toThrow(/satu-satunya peran Super Admin/)
  })

  test('peran yang masih menjadi induk tidak bisa dihapus', async () => {
    const { docs } = await payload.find({
      collection: 'roles' as never,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: 'reader' } },
    })
    await expect(
      payload.delete({ id: docs[0].id, collection: 'roles' as never, overrideAccess: true }),
    ).rejects.toThrow(/menjadi induk/)
  })

  test('non-super-admin tidak bisa memberi peran kepada siapa pun', async () => {
    const editor = await asUser('editor@test.local')
    const target = await asUser('reader@test.local')

    const rootRole = await payload.find({
      collection: 'roles' as never,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: 'root' } },
    })

    // Beri editor izin update pada users supaya yang diuji benar-benar
    // penguncian field `roles`, bukan sekadar tidak boleh mengubah user.
    const editorRole = await payload.find({
      collection: 'roles' as never,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: 'editor' } },
    })
    await payload.update({
      id: editorRole.docs[0].id,
      collection: 'roles' as never,
      data: {
        collectionPermissions: [
          { collection: 'posts', update: true },
          { collection: 'users', read: true, update: true },
        ],
      } as never,
      overrideAccess: true,
    })

    await payload.update({
      id: (target as unknown as { id: number | string }).id,
      collection: 'users',
      data: { roles: [rootRole.docs[0].id] } as never,
      overrideAccess: false,
      user: editor,
    })

    const fresh = await payload.findByID({
      id: (target as unknown as { id: number | string }).id,
      collection: 'users',
      depth: 0,
      overrideAccess: true,
    })
    expect((fresh as Record<string, never>).roles).not.toContain(rootRole.docs[0].id)
  })
})

describe('tingkat akses field, diuji lewat Payload sungguhan', () => {
  let docId: number | string
  let readonlyUser: TypedUser
  let hiddenUser: TypedUser

  beforeAll(async () => {
    const readonlyRole = await createRole({
      name: 'Notes Read Only',
      slug: 'notes-readonly',
      canAccessAdmin: true,
      collectionPermissions: [
        { collection: 'posts', fieldAccess: { internalNotes: 'readonly' }, read: true, update: true },
      ],
    })
    const hiddenRole = await createRole({
      name: 'Notes Hidden',
      slug: 'notes-hidden',
      canAccessAdmin: true,
      collectionPermissions: [
        { collection: 'posts', fieldAccess: { internalNotes: 'hidden' }, read: true, update: true },
      ],
    })

    await createUser('ro@test.local', [readonlyRole.id])
    await createUser('hidden@test.local', [hiddenRole.id])
    readonlyUser = await asUser('ro@test.local')
    hiddenUser = await asUser('hidden@test.local')

    const doc = await payload.create({
      collection: 'posts',
      data: { internalNotes: 'rahasia', title: 'Judul' } as never,
      overrideAccess: true,
    })
    docId = doc.id
  })

  test('"hanya baca" — nilainya TERLIHAT', async () => {
    const doc = await payload.findByID({
      id: docId,
      collection: 'posts',
      overrideAccess: false,
      user: readonlyUser,
    })
    expect((doc as Record<string, unknown>).internalNotes).toBe('rahasia')
  })

  test('"hanya baca" — perubahannya DIABAIKAN', async () => {
    await payload.update({
      id: docId,
      collection: 'posts',
      data: { internalNotes: 'coba diubah', title: 'Judul baru' } as never,
      overrideAccess: false,
      user: readonlyUser,
    })

    const fresh = await payload.findByID({ id: docId, collection: 'posts', overrideAccess: true })
    // Field lain tetap tersimpan — yang ditolak hanya field yang dibatasi.
    expect(fresh.title).toBe('Judul baru')
    expect((fresh as Record<string, unknown>).internalNotes).toBe('rahasia')
  })

  test('"tersembunyi" — nilainya TIDAK ikut terkirim', async () => {
    const doc = await payload.findByID({
      id: docId,
      collection: 'posts',
      overrideAccess: false,
      user: hiddenUser,
    })
    expect(doc.title).toBeDefined()
    expect((doc as Record<string, unknown>).internalNotes).toBeUndefined()
  })

  test('"tersembunyi" — perubahannya juga diabaikan', async () => {
    await payload.update({
      id: docId,
      collection: 'posts',
      data: { internalNotes: 'tembus?' } as never,
      overrideAccess: false,
      user: hiddenUser,
    })
    const fresh = await payload.findByID({ id: docId, collection: 'posts', overrideAccess: true })
    expect((fresh as Record<string, unknown>).internalNotes).toBe('rahasia')
  })

  test('kebijakan allowlist pada baris collection ditegakkan', async () => {
    const role = await createRole({
      name: 'Hanya Judul',
      slug: 'hanya-judul',
      canAccessAdmin: true,
      collectionPermissions: [
        {
          collection: 'posts',
          fieldAccess: { title: 'edit' },
          fieldPolicy: 'allowlist',
          read: true,
          update: true,
        },
      ],
    })
    await createUser('judul@test.local', [role.id])
    const user = await asUser('judul@test.local')

    await payload.update({
      id: docId,
      collection: 'posts',
      data: { internalNotes: 'tidak boleh', title: 'Judul dari allowlist' } as never,
      overrideAccess: false,
      user,
    })

    const fresh = await payload.findByID({ id: docId, collection: 'posts', overrideAccess: true })
    expect(fresh.title).toBe('Judul dari allowlist')
    expect((fresh as Record<string, unknown>).internalNotes).toBe('rahasia')
  })
})
