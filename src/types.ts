import type { Config } from 'payload'

/**
 * Aksi CRUD pada sebuah collection. `readVersions` memisahkan "boleh melihat
 * dokumen" dari "boleh melihat draft/versi lama" — editor butuh yang kedua untuk
 * live preview, reviewer sering hanya boleh yang pertama.
 */
export type CollectionAction = 'create' | 'delete' | 'read' | 'readVersions' | 'update'

export type GlobalAction = 'read' | 'update'

/** Aksi yang bisa diatur pada level field (sesuai `FieldAccess` milik Payload). */
export type FieldAction = 'create' | 'read' | 'update'

/**
 * Tingkat akses satu field — SATU pilihan, bukan tiga centang.
 *
 * Ketiganya memetakan langsung ke perilaku Payload yang sudah ada, bukan
 * istilah buatan:
 *
 * | Pilihan    | read  | create | update | Yang dilihat pengguna              |
 * |------------|-------|--------|--------|------------------------------------|
 * | `hidden`   | false | false  | false  | field tidak dirender sama sekali   |
 * | `readonly` | true  | false  | false  | field tampil, tapi tidak bisa diisi|
 * | `edit`     | true  | true   | true   | normal                             |
 *
 * Payload sendiri yang menegakkannya: `RenderFields` mengembalikan `null` bila
 * tak ada izin baca, dan memaksa `readOnly` bila tak ada izin operasinya.
 */
export type FieldAccessLevel = 'edit' | 'hidden' | 'readonly'

/** Satu field yang bisa diatur, seperti dikirim ke pemilih di panel admin. */
export interface EntityFieldInfo {
  /** Label yang dilihat admin, mis. `Hero › Judul`. */
  label: string
  /** Path titik, mis. `hero.title`. */
  path: string
  type: string
}

/**
 * Nilai field `fieldAccess` pada satu baris collection/global: path field →
 * tingkat akses. Hanya path yang MENYIMPANG dari bawaan yang dicatat, jadi
 * baris tanpa pengecualian tetap kosong.
 */
export type FieldAccessMap = Record<string, FieldAccessLevel>

export type CollectionPermission = Record<CollectionAction, boolean>

export type GlobalPermission = Record<GlobalAction, boolean>

export type FieldPermission = Record<FieldAction, boolean>

/** Jenis entitas yang izinnya dikelola. */
export type EntityType = 'collection' | 'global'

/**
 * Kebijakan field milik SATU peran terhadap SATU entitas.
 *
 * - `restrict` (bawaan): semua field boleh, kecuali yang didaftarkan menolak.
 * - `allowlist`: hanya field yang didaftarkan yang boleh; sisanya ditolak.
 *   Hanya berlaku pada entitas yang punya minimal satu baris field — collection
 *   lain tidak ikut terkunci.
 */
export type FieldPolicy = 'allowlist' | 'restrict'

/**
 * Aturan field milik SATU peran, sudah diringkas agar bisa di-cache sebagai JSON.
 * Disimpan per peran (bukan digabung) karena penggabungan izin field harus tahu
 * peran mana yang berpendapat — lihat `fieldPermissionFor` di core/matrix.ts.
 */
export type RoleFieldRules = {
  /** Entitas (`collection:pages`) yang peran ini punya izin atasnya. */
  entities: string[]
  /** Kunci `${entityType}:${slug}:${fieldPath}` → izin eksplisit. */
  fields: Record<string, FieldPermission>
  /** Kunci `${entityType}:${slug}` → kebijakan field peran ini di entitas itu. */
  policies: Record<string, FieldPolicy>
  superAdmin: boolean
}

/** Hasil akhir penggabungan seluruh peran milik seorang user. */
export type PermissionMatrix = {
  /** True bila belum ada peran apa pun di database (mode anti-lockout). */
  bootstrap: boolean
  canAccessAdmin: boolean
  collections: Record<string, CollectionPermission>
  globals: Record<string, GlobalPermission>
  /** Jalan pintas: bila tidak ada aturan field sama sekali, lewati evaluasinya. */
  hasFieldRules: boolean
  roleFieldRules: RoleFieldRules[]
  /** Slug peran yang efektif, termasuk hasil pewarisan dari peran induk. */
  roleSlugs: string[]
  superAdmin: boolean
}

/**
 * Penyimpanan cache matriks izin. Bawaannya in-memory (cukup untuk satu proses);
 * ganti dengan Redis/Memcached bila aplikasi berjalan multi-instance, supaya
 * perubahan peran langsung terasa di semua node.
 */
export type PayloadRbacCache = {
  /** Hapus seluruh key yang diawali prefix ini. */
  clear: (keyPrefix: string) => Promise<void>
  get: (key: string) => Promise<null | string>
  set: (key: string, value: string, ttlSeconds: number) => Promise<void>
}

export type EntityLabel = {
  label: string
  slug: string
}

export type PayloadRbacPluginConfig = {
  /** Grup sidebar untuk collection `roles`. Bawaan `System`. */
  adminGroup?: string

  /**
   * Collection auth yang memiliki peran (staf/admin).
   * Bawaan: `config.admin.user`, atau `users`.
   */
  authCollection?: string

  /**
   * Saat collection `roles` masih kosong, perlakukan staf yang login sebagai
   * super admin. Mencegah instalasi baru terkunci dari /admin. Bawaan: true.
   */
  bootstrapSuperAdmin?: boolean

  cache?: PayloadRbacCache

  /** Umur cache matriks izin. Bawaan 60 detik. */
  cacheTTLSeconds?: number
  /**
   * Collection yang izinnya dikelola. Bawaan: SEMUA collection yang ditemukan
   * di config (itulah sisi "dynamic"-nya — tidak ada registry yang perlu
   * dirawat manual). Isi array untuk membatasi.
   */
  collections?: string[]

  /**
   * Matikan penegakan izin tanpa membuang collection `roles`, sehingga skema
   * database tetap konsisten untuk migrasi. Bawaan: aktif.
   */
  disabled?: boolean
  /** Pasang `access.admin` pada collection auth dari `canAccessAdmin`. Bawaan: true. */
  enforceAdminAccess?: boolean

  /**
   * Pasang `access` CRUD pada collection/global yang dikelola. Matikan bila
   * aplikasi sudah punya access control sendiri dan hanya ingin memakai
   * lapisan field. Bawaan: true.
   */
  enforceCollectionAccess?: boolean

  /** Pasang `access` pada setiap field. Bawaan: true. */
  enforceFieldAccess?: boolean

  /** Label yang lebih ramah untuk slug tertentu di dropdown izin. */
  entityLabels?: Record<string, string>

  excludeCollections?: string[]

  /**
   * Path field yang tidak boleh disentuh RBAC — dipakai untuk field yang bila
   * tertutup akan merusak panel admin. Format sama seperti nilai dropdown:
   * `collection:users:email`. Field auth bawaan Payload sudah dikecualikan.
   */
  excludeFieldPaths?: string[]

  excludeGlobals?: string[]
  /**
   * Batasi entitas mana yang muncul di dropdown izin field. Berguna pada proyek
   * besar: tanpa ini dropdown berisi seluruh field dari seluruh collection.
   */
  fieldPermissionEntities?: string[]

  /** Sama seperti di atas, untuk global. */
  globals?: string[]

  /** Slug collection peran. Bawaan `roles`. */
  rolesSlug?: string

  /** Nama field relasi peran pada collection auth. Bawaan `roles`. */
  userRolesField?: string
}

/** Opsi yang sudah dinormalisasi — dipakai internal oleh mesin RBAC. */
export type ResolvedOptions = {
  cache: PayloadRbacCache
} & Required<
  Pick<
    PayloadRbacPluginConfig,
    | 'adminGroup'
    | 'authCollection'
    | 'bootstrapSuperAdmin'
    | 'cacheTTLSeconds'
    | 'enforceAdminAccess'
    | 'enforceCollectionAccess'
    | 'enforceFieldAccess'
    | 'rolesSlug'
    | 'userRolesField'
  >
>

export type PluginFactory = (config: Config) => Config
