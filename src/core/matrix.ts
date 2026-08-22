import type {
  CollectionPermission,
  FieldAccessLevel,
  FieldAccessMap,
  FieldPermission,
  FieldPolicy,
  GlobalPermission,
  PermissionMatrix,
  RoleFieldRules,
} from '../types.js'

/**
 * Penggabungan peran → matriks izin.
 *
 * Dua aturan yang menentukan seluruh perilaku di file ini:
 *
 * 1. ADITIF (OR). Punya dua peran = punya gabungan izin keduanya; peran paling
 *    longgar menang. Tidak ada "deny menang", karena RBAC yang bisa saling
 *    membatalkan sangat sulit ditebak admin: mencabut satu centang di satu peran
 *    tidak pernah menambah akses.
 *
 * 2. NESTED. Peran boleh punya induk dan mewarisi seluruh izinnya. Pewarisan
 *    diselesaikan lebih dulu (`expandWithAncestors`), jadi mesin penggabung di
 *    bawah tidak perlu tahu soal hierarki — ia hanya menerima daftar peran datar.
 *
 * Izin field TIDAK boleh digabung dengan meng-OR baris-barisnya begitu saja.
 * Baris field bisa berarti "tolak", dan meng-OR-kannya akan membuat penolakan
 * dari satu peran ikut mengenai peran lain yang tidak pernah membatasi field
 * itu — kebalikan dari aturan (1). Karena itu aturan field disimpan per peran
 * (`roleFieldRules`) dan baru dievaluasi saat ditanya, lihat `fieldPermissionFor`.
 */

export type RoleDoc = {
  canAccessAdmin?: boolean | null
  collectionPermissions?:
    | ({
        collection?: null | string
        fieldAccess?: FieldAccessMap | null
        fieldPolicy?: FieldPolicy | null
      } & Partial<CollectionPermission>)[]
    | null
  fieldPermissions?:
    | ({ access?: FieldAccessLevel | null; target?: null | string } & Partial<FieldPermission>)[]
    | null
  /** Bentuk lama (array kebijakan terpisah). Masih dibaca demi data yang sudah ada. */
  fieldPolicies?: { entity?: null | string; policy?: FieldPolicy | null }[] | null
  globalPermissions?:
    | ({
        fieldAccess?: FieldAccessMap | null
        fieldPolicy?: FieldPolicy | null
        global?: null | string
      } & Partial<GlobalPermission>)[]
    | null
  id: number | string
  /** Diisi saat perataan: slug peran ini beserta seluruh induknya. */
  inheritedSlugs?: string[]
  isSuperAdmin?: boolean | null
  parent?: null | number | RoleDoc | string
  slug?: null | string
}

export const NO_COLLECTION_ACCESS: CollectionPermission = {
  create: false,
  delete: false,
  read: false,
  readVersions: false,
  update: false,
}

export const FULL_COLLECTION_ACCESS: CollectionPermission = {
  create: true,
  delete: true,
  read: true,
  readVersions: true,
  update: true,
}

export const NO_GLOBAL_ACCESS: GlobalPermission = { read: false, update: false }
export const FULL_GLOBAL_ACCESS: GlobalPermission = { read: true, update: true }

export const FULL_FIELD_ACCESS: FieldPermission = { create: true, read: true, update: true }
export const NO_FIELD_ACCESS: FieldPermission = { create: false, read: false, update: false }

export const emptyMatrix = (): PermissionMatrix => ({
  bootstrap: false,
  canAccessAdmin: false,
  collections: {},
  globals: {},
  hasFieldRules: false,
  roleFieldRules: [],
  roleSlugs: [],
  superAdmin: false,
})

export const superAdminMatrix = (bootstrap = false): PermissionMatrix => ({
  ...emptyMatrix(),
  bootstrap,
  canAccessAdmin: true,
  superAdmin: true,
})

const roleId = (value: unknown): null | number | string => {
  if (typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    return (value as { id?: number | string }).id ?? null
  }
  return null
}

/**
 * Ratakan satu peran bersama seluruh induknya menjadi SATU peran sintetis.
 *
 * Pewarisan tidak sama dengan memegang dua peran sekaligus, dan membedakannya
 * itu penting:
 *
 *   - Dua peran terpisah → OR. Tidak ada peran yang boleh memangkas hak yang
 *     diberikan peran lain.
 *   - Peran turunan → peran turunan ADALAH induknya plus penyesuaiannya. Kalau
 *     turunan menutup sebuah field, penutupan itu harus berlaku; kalau di-OR
 *     dengan induk yang tidak menutupnya, aturan turunan tidak pernah bisa
 *     mempersempit apa pun dan fitur pewarisan jadi tidak ada gunanya.
 *
 * Izin collection/global tetap aditif (pewarisan hanya menambah). Yang bisa
 * ditimpa turunan adalah baris field dan kebijakan field, karena di situlah
 * penyempitan memang dimaksudkan.
 *
 * `seen` bukan sekadar optimisasi: rantai induk bisa melingkar (A→B→A) kalau
 * seseorang menyuntingnya lewat API, dan tanpa penjaga ini rekursinya tidak
 * pernah berhenti. Validasi di collection `roles` menolak siklus saat disimpan,
 * tapi data yang sudah terlanjur melingkar tetap harus bisa dibaca.
 */
const flattenChain = (startId: number | string, byId: Map<string, RoleDoc>): null | RoleDoc => {
  const chain: RoleDoc[] = []
  const seen = new Set<string>()
  let cursor: null | number | string = startId

  while (cursor !== null && cursor !== undefined) {
    const key = String(cursor)
    if (seen.has(key)) {
      break
    }
    seen.add(key)

    const role = byId.get(key)
    if (!role) {
      break
    }
    chain.push(role)
    cursor = roleId(role.parent)
  }

  if (!chain.length) {
    return null
  }

  // Dari leluhur terjauh ke peran itu sendiri, supaya yang terakhir menang.
  chain.reverse()

  const collections = new Map<
    string,
    { fieldAccess?: FieldAccessMap | null; fieldPolicy?: FieldPolicy | null } & Partial<CollectionPermission>
  >()
  const globals = new Map<
    string,
    { fieldAccess?: FieldAccessMap | null; fieldPolicy?: FieldPolicy | null } & Partial<GlobalPermission>
  >()
  const fields = new Map<string, { target: string } & Partial<FieldPermission>>()
  const policies = new Map<string, FieldPolicy>()
  const slugs: string[] = []

  let isSuperAdmin = false
  let canAccessAdmin = false

  for (const role of chain) {
    if (role.slug) {
      slugs.push(role.slug)
    }
    isSuperAdmin ||= Boolean(role.isSuperAdmin)
    canAccessAdmin ||= Boolean(role.canAccessAdmin)

    for (const row of role.collectionPermissions ?? []) {
      if (!row?.collection) {
        continue
      }
      const current = collections.get(row.collection) ?? {}
      collections.set(row.collection, {
        collection: row.collection,
        create: current.create || Boolean(row.create),
        delete: current.delete || Boolean(row.delete),
        // Akses per field digabung PER PATH: turunan menimpa induk hanya pada
        // field yang benar-benar ia sebut, sisanya tetap warisan.
        fieldAccess: { ...current.fieldAccess, ...row.fieldAccess },
        // Kebijakan field bukan izin, jadi TIDAK di-OR: ia pilihan yang
        // ditimpa turunan, sama seperti baris field itu sendiri.
        fieldPolicy: row.fieldPolicy ?? current.fieldPolicy,
        read: current.read || Boolean(row.read),
        readVersions: current.readVersions || Boolean(row.readVersions),
        update: current.update || Boolean(row.update),
      } as Partial<CollectionPermission>)
    }

    for (const row of role.globalPermissions ?? []) {
      if (!row?.global) {
        continue
      }
      const current = globals.get(row.global) ?? {}
      globals.set(row.global, {
        fieldAccess: { ...current.fieldAccess, ...row.fieldAccess },
        fieldPolicy: row.fieldPolicy ?? current.fieldPolicy,
        global: row.global,
        read: current.read || Boolean(row.read),
        update: current.update || Boolean(row.update),
      } as Partial<GlobalPermission>)
    }

    // Baris field & kebijakan: turunan MENIMPA induk untuk target yang sama.
    for (const row of role.fieldPermissions ?? []) {
      if (row?.target) {
        fields.set(row.target, { ...row, target: row.target })
      }
    }
    for (const row of role.fieldPolicies ?? []) {
      if (row?.entity) {
        policies.set(row.entity, row.policy === 'allowlist' ? 'allowlist' : 'restrict')
      }
    }
  }

  const self = chain[chain.length - 1]
  return {
    id: self.id,
    slug: self.slug,
    canAccessAdmin,
    collectionPermissions: [...collections.values()] as RoleDoc['collectionPermissions'],
    fieldPermissions: [...fields.values()],
    fieldPolicies: [...policies.entries()].map(([entity, policy]) => ({ entity, policy })),
    globalPermissions: [...globals.values()] as RoleDoc['globalPermissions'],
    inheritedSlugs: slugs,
    isSuperAdmin,
  }
}

/**
 * Ubah daftar id peran milik user menjadi daftar peran sintetis yang siap
 * di-OR: satu peran sintetis per peran yang benar-benar ditugaskan, masing-masing
 * sudah menyerap rantai induknya.
 */
export const resolveAssignedRoles = (
  startIds: (number | string)[],
  byId: Map<string, RoleDoc>,
): RoleDoc[] => {
  const out: RoleDoc[] = []
  const seen = new Set<string>()

  for (const id of startIds) {
    const key = String(id)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const flat = flattenChain(id, byId)
    if (flat) {
      out.push(flat)
    }
  }

  return out
}

/** `collection:pages:hero.title` → `collection:pages` */
const entityOf = (target: string): string => target.split(':').slice(0, 2).join(':')

/** Ringkas aturan field satu peran ke bentuk yang bisa di-cache sebagai JSON. */
const compileFieldRules = (role: RoleDoc): RoleFieldRules => {
  const policies: Record<string, FieldPolicy> = {}

  // Kebijakan field hidup di baris entitasnya sendiri — satu tempat dengan
  // centang CRUD-nya. Sebelumnya ia array terpisah, dan memisahkannya membuat
  // orang harus menghubungkan dua daftar di kepala hanya untuk membaca satu
  // aturan.
  for (const row of role.collectionPermissions ?? []) {
    if (row?.collection && row.fieldPolicy) {
      policies[`collection:${row.collection}`] = row.fieldPolicy
    }
  }
  for (const row of role.globalPermissions ?? []) {
    if (row?.global && row.fieldPolicy) {
      policies[`global:${row.global}`] = row.fieldPolicy
    }
  }
  // Data dari versi sebelumnya, saat kebijakan masih array sendiri.
  for (const row of role.fieldPolicies ?? []) {
    if (row?.entity && row.policy && !policies[row.entity]) {
      policies[row.entity] = row.policy
    }
  }

  const fields: Record<string, FieldPermission> = {}

  // Bentuk sekarang: peta `path → tingkat akses` di dalam baris entitasnya.
  const readAccessMap = (entity: string, map: FieldAccessMap | null | undefined): void => {
    if (!map || typeof map !== 'object') {
      return
    }
    for (const [fieldPath, level] of Object.entries(map)) {
      const permission = LEVEL_PERMISSIONS[level]
      if (permission) {
        fields[`${entity}:${fieldPath}`] = permission
      }
    }
  }
  for (const row of role.collectionPermissions ?? []) {
    if (row?.collection) {
      readAccessMap(`collection:${row.collection}`, row.fieldAccess)
    }
  }
  for (const row of role.globalPermissions ?? []) {
    if (row?.global) {
      readAccessMap(`global:${row.global}`, row.fieldAccess)
    }
  }

  // Bentuk lama: array datar `fieldPermissions` dengan target lengkap.
  for (const row of role.fieldPermissions ?? []) {
    if (!row?.target || fields[row.target]) {
      continue
    }
    fields[row.target] = levelToPermission(row)
  }

  // Entitas yang peran ini punya izin atasnya. Peran yang tidak punya izin sama
  // sekali di sebuah collection tidak boleh ikut menentukan nasib field di sana
  // — ia tidak "mengizinkan" apa pun, dan juga tidak berhak menolak.
  const entities: string[] = []
  for (const row of role.collectionPermissions ?? []) {
    if (row?.collection) {
      entities.push(`collection:${row.collection}`)
    }
  }
  for (const row of role.globalPermissions ?? []) {
    if (row?.global) {
      entities.push(`global:${row.global}`)
    }
  }
  // Entitas yang hanya disebut di baris field tetap dihitung, supaya konfigurasi
  // yang hanya mengatur field (izin collection diberikan peran lain) tetap jalan.
  for (const target of Object.keys(fields)) {
    entities.push(entityOf(target))
  }

  return {
    entities: [...new Set(entities)],
    fields,
    policies,
    superAdmin: Boolean(role.isSuperAdmin),
  }
}

/** Tingkat akses → tiga izin yang dimengerti Payload. */
export const LEVEL_PERMISSIONS: Record<FieldAccessLevel, FieldPermission> = {
  edit: { create: true, read: true, update: true },
  hidden: { create: false, read: false, update: false },
  readonly: { create: false, read: true, update: false },
}

/**
 * Baca satu baris izin field.
 *
 * Bentuk lama menyimpan tiga boolean terpisah; bentuk sekarang satu pilihan.
 * Baris lama tetap dibaca supaya peran yang sudah tersimpan tidak berubah arti
 * setelah plugin diperbarui — `read` tanpa `update` memang berarti "hanya baca".
 */
const levelToPermission = (row: {
  access?: FieldAccessLevel | null
  create?: boolean
  read?: boolean
  update?: boolean
}): FieldPermission => {
  if (row.access && LEVEL_PERMISSIONS[row.access]) {
    return LEVEL_PERMISSIONS[row.access]
  }
  return {
    create: Boolean(row.create),
    read: Boolean(row.read),
    update: Boolean(row.update),
  }
}

/** Gabungkan daftar peran (yang sudah termasuk induknya) menjadi satu matriks. */
export const mergeRoles = (roles: RoleDoc[]): PermissionMatrix => {
  const matrix = emptyMatrix()

  for (const role of roles) {
    for (const slug of role.inheritedSlugs ?? (role.slug ? [role.slug] : [])) {
      if (!matrix.roleSlugs.includes(slug)) {
        matrix.roleSlugs.push(slug)
      }
    }
    if (role.isSuperAdmin) {
      matrix.superAdmin = true
    }
    if (role.canAccessAdmin) {
      matrix.canAccessAdmin = true
    }

    for (const row of role.collectionPermissions ?? []) {
      if (!row?.collection) {
        continue
      }
      const current = matrix.collections[row.collection] ?? { ...NO_COLLECTION_ACCESS }
      matrix.collections[row.collection] = {
        create: current.create || Boolean(row.create),
        delete: current.delete || Boolean(row.delete),
        read: current.read || Boolean(row.read),
        readVersions: current.readVersions || Boolean(row.readVersions),
        update: current.update || Boolean(row.update),
      }
    }

    for (const row of role.globalPermissions ?? []) {
      if (!row?.global) {
        continue
      }
      const current = matrix.globals[row.global] ?? { ...NO_GLOBAL_ACCESS }
      matrix.globals[row.global] = {
        read: current.read || Boolean(row.read),
        update: current.update || Boolean(row.update),
      }
    }

    const rules = compileFieldRules(role)
    matrix.roleFieldRules.push(rules)
    if (Object.keys(rules.fields).length > 0 || Object.keys(rules.policies).length > 0) {
      matrix.hasFieldRules = true
    }
  }

  // Super admin selalu boleh masuk panel, apa pun centangnya — kalau tidak,
  // satu centang yang lupa dicentang mengunci administrator dari /admin.
  if (matrix.superAdmin) {
    matrix.canAccessAdmin = true
  }

  return matrix
}

export const collectionPermissionFor = (
  matrix: PermissionMatrix,
  slug: string,
): CollectionPermission =>
  matrix.superAdmin ? FULL_COLLECTION_ACCESS : (matrix.collections[slug] ?? NO_COLLECTION_ACCESS)

export const globalPermissionFor = (matrix: PermissionMatrix, slug: string): GlobalPermission =>
  matrix.superAdmin ? FULL_GLOBAL_ACCESS : (matrix.globals[slug] ?? NO_GLOBAL_ACCESS)

/** Keputusan satu peran terhadap satu field. `null` = peran ini tidak berpendapat. */
const roleVerdict = (
  rules: RoleFieldRules,
  entityKeyValue: string,
  fieldKeyValue: string,
): FieldPermission | null => {
  if (rules.superAdmin) {
    return FULL_FIELD_ACCESS
  }
  if (!rules.entities.includes(entityKeyValue)) {
    return null
  }
  const explicit = rules.fields[fieldKeyValue]
  if (explicit) {
    return explicit
  }
  if (rules.policies[entityKeyValue] !== 'allowlist') {
    return FULL_FIELD_ACCESS
  }

  // Mode allowlist. Sebuah group/array/blocks yang tidak didaftarkan tetap harus
  // dilewatkan bila ada anaknya yang didaftarkan — Payload membuang seluruh
  // cabang begitu wadahnya ditolak, sehingga mendaftarkan `hero.heading` saja
  // tidak akan pernah berpengaruh kalau `hero` ikut tertutup. Wadah bukan data;
  // yang benar-benar dijaga tetap field daunnya.
  return descendantVerdict(rules, fieldKeyValue)
}

/** Izin gabungan seluruh field terdaftar yang berada DI BAWAH path ini. */
const descendantVerdict = (rules: RoleFieldRules, fieldKeyValue: string): FieldPermission => {
  const prefix = `${fieldKeyValue}.`
  const merged: FieldPermission = { create: false, read: false, update: false }
  let found = false

  for (const [target, perms] of Object.entries(rules.fields)) {
    if (!target.startsWith(prefix)) {
      continue
    }
    found = true
    merged.create ||= perms.create
    merged.read ||= perms.read
    merged.update ||= perms.update
  }

  return found ? merged : NO_FIELD_ACCESS
}

/**
 * Keputusan gabungan untuk satu field.
 *
 * Bawaannya IZINKAN: izin field adalah penyempit di atas izin collection, bukan
 * lapisan izin kedua yang harus diisi ulang. Kalau bawaannya tolak, memasang
 * plugin ini akan langsung mengosongkan setiap formulir di panel admin.
 *
 * Bila tidak ada satu peran pun yang berpendapat soal entitas ini, hasilnya juga
 * izinkan — penolakan sudah menjadi urusan access control collection, dan
 * menolak di sini hanya akan menutup field bagi pembaca publik yang sah.
 */
export const fieldPermissionFor = (
  matrix: PermissionMatrix,
  entityKeyValue: string,
  fieldKeyValue: string,
): FieldPermission => {
  if (matrix.superAdmin || !matrix.hasFieldRules) {
    return FULL_FIELD_ACCESS
  }

  let opinionated = false
  const merged: FieldPermission = { create: false, read: false, update: false }

  for (const rules of matrix.roleFieldRules) {
    const verdict = roleVerdict(rules, entityKeyValue, fieldKeyValue)
    if (!verdict) {
      continue
    }
    opinionated = true
    merged.create ||= verdict.create
    merged.read ||= verdict.read
    merged.update ||= verdict.update
    if (merged.create && merged.read && merged.update) {
      return FULL_FIELD_ACCESS
    }
  }

  return opinionated ? merged : FULL_FIELD_ACCESS
}
