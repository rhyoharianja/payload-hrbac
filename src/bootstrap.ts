import type { Payload } from 'payload'

import type { CollectionPermission, FieldPolicy, GlobalPermission } from './types.js'

/**
 * Pembuatan peran awal + penetapan super admin.
 *
 * Ada satu jebakan yang membuat helper ini wajib ada: selama collection `roles`
 * kosong, mesin RBAC berjalan dalam mode bootstrap dan semua pengguna dianggap
 * super admin. Begitu peran PERTAMA dibuat, mode itu mati — dan pengguna yang
 * sudah ada belum punya peran apa pun, jadi mereka langsung kehilangan akses.
 *
 * Jalankan ini sekali setelah memasang plugin, sebelum membuat peran dari GUI.
 *
 * Idempoten: peran dicocokkan lewat `slug`. Peran yang sudah ada tidak ditimpa,
 * supaya penyesuaian manual admin tidak hilang saat skrip dijalankan ulang.
 */

export type RoleSeed = {
  canAccessAdmin?: boolean
  collectionPermissions?: ({ collection: string } & Partial<CollectionPermission>)[]
  description?: string
  fieldPermissions?: { create?: boolean; read?: boolean; target: string; update?: boolean }[]
  fieldPolicies?: { entity: string; policy: FieldPolicy }[]
  globalPermissions?: ({ global: string } & Partial<GlobalPermission>)[]
  isSuperAdmin?: boolean
  name: string
  /** Slug peran induk. Diselesaikan setelah semua peran dibuat. */
  parent?: string
  slug: string
}

export type BootstrapOptions = {
  /**
   * Siapa yang menerima peran super admin bila belum punya peran.
   * - `'auto'` (bawaan): hanya bila TEPAT SATU pengguna yang belum punya peran.
   *   Kalau lebih, skrip tidak menebak siapa yang layak — ia hanya memberi tahu.
   * - array email: pengguna dengan email tersebut.
   * - `'none'`: jangan tetapkan apa pun.
   */
  assignSuperAdminTo?: 'auto' | 'none' | string[]
  authCollection?: string
  /** Peran yang dibuat. Bawaan: satu peran Super Admin. */
  roles?: RoleSeed[]
  rolesSlug?: string
  userRolesField?: string
}

export const DEFAULT_SUPER_ADMIN: RoleSeed = {
  name: 'Super Admin',
  slug: 'super-admin',
  canAccessAdmin: true,
  description: 'Akses penuh ke seluruh data dan pengaturan, termasuk mengelola peran.',
  isSuperAdmin: true,
}

export const bootstrapRoles = async (
  payload: Payload,
  options: BootstrapOptions = {},
): Promise<void> => {
  const rolesSlug = options.rolesSlug ?? 'roles'
  const authCollection = options.authCollection ?? 'users'
  const userRolesField = options.userRolesField ?? 'roles'
  const seeds = options.roles ?? [DEFAULT_SUPER_ADMIN]
  const assign = options.assignSuperAdminTo ?? 'auto'

  const idBySlug = new Map<string, number | string>()
  const created: string[] = []

  // Dua lintasan: peran dibuat dulu tanpa `parent`, baru ditautkan. Kalau tidak,
  // peran yang menunjuk induk yang belum dibuat akan gagal validasi relasinya.
  for (const seed of seeds) {
    const existing = await payload.find({
      collection: rolesSlug as never,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: seed.slug } },
    })

    if (existing.docs.length) {
      idBySlug.set(seed.slug, existing.docs[0].id)
      continue
    }

    const { parent: _parent, ...rest } = seed
    const doc = await payload.create({
      collection: rolesSlug as never,
      data: { ...rest, isSystem: true } as never,
      overrideAccess: true,
    })
    idBySlug.set(seed.slug, doc.id)
    created.push(seed.slug)
  }

  for (const seed of seeds) {
    if (!seed.parent) {
      continue
    }
    const selfId = idBySlug.get(seed.slug)
    const parentId = idBySlug.get(seed.parent)
    if (selfId === undefined || parentId === undefined) {
      payload.logger.warn(
        `[payload-rbac] Peran induk \`${seed.parent}\` untuk \`${seed.slug}\` tidak ditemukan — pewarisan dilewati.`,
      )
      continue
    }
    await payload.update({
      id: selfId,
      collection: rolesSlug as never,
      data: { parent: parentId } as never,
      overrideAccess: true,
    })
  }

  payload.logger.info(
    `[payload-rbac] peran dibuat: ${created.length ? created.join(', ') : '— (semua sudah ada)'}`,
  )

  if (assign === 'none') {
    return
  }

  const superAdminSlug = seeds.find((s) => s.isSuperAdmin)?.slug
  const superAdminId = superAdminSlug ? idBySlug.get(superAdminSlug) : undefined
  if (superAdminId === undefined) {
    payload.logger.warn(
      '[payload-rbac] Tidak ada peran super admin di daftar seed — tidak ada yang ditetapkan.',
    )
    return
  }

  const { docs: users } = await payload.find({
    collection: authCollection as never,
    depth: 0,
    limit: 1000,
    overrideAccess: true,
  })
  const withoutRoles = users.filter(
    (u) => !((u as Record<string, unknown>)[userRolesField] as undefined | unknown[])?.length,
  )

  if (!withoutRoles.length) {
    payload.logger.info('[payload-rbac] semua pengguna sudah punya peran.')
    return
  }

  const targets = Array.isArray(assign)
    ? withoutRoles.filter((u) => assign.includes((u as { email?: string }).email ?? ''))
    : withoutRoles.length === 1
      ? withoutRoles
      : []

  if (!targets.length) {
    // Menaikkan hak orang lain secara otomatis bukan keputusan yang boleh
    // diambil skrip. Lebih baik terkunci dan diberi tahu daripada diam-diam
    // memberi akses penuh ke pengguna yang tidak seharusnya.
    payload.logger.warn(
      `[payload-rbac] ${withoutRoles.length} pengguna belum punya peran: ` +
        `${withoutRoles.map((u) => (u as { email?: string }).email).join(', ')}. ` +
        'Tetapkan perannya lewat panel admin, atau oper daftar email ke `assignSuperAdminTo`.',
    )
    return
  }

  for (const user of targets) {
    await payload.update({
      id: user.id,
      collection: authCollection as never,
      data: { [userRolesField]: [superAdminId] } as never,
      overrideAccess: true,
    })
    payload.logger.info(
      `[payload-rbac] ${(user as { email?: string }).email} ditetapkan sebagai Super Admin.`,
    )
  }
}
