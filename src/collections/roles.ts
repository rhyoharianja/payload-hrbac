import type { CollectionConfig, Field, OptionObject, Tab } from 'payload'

import type { ResolvedOptions } from '../types.js'

import { getPermissions, invalidatePermissions } from '../core/permissions.js'

/**
 * Collection `roles` — RBAC yang dikonfigurasi dari GUI, bukan dari kode.
 *
 * Yang tetap di kode: MEKANISME penegakan izin. Yang dari GUI: peran apa saja
 * yang ada, siapa mewarisi siapa, dan izin mana yang dicentang. Menambah peran
 * atau menggeser hak akses karena itu tidak butuh deploy.
 *
 * Tiga pengaman anti-terkunci, dan semuanya perlu:
 *   1. Peran `isSuperAdmin` mengabaikan seluruh centang. Hook `beforeDelete`
 *      menolak penghapusan peran super admin yang terakhir.
 *   2. Peran `isSystem` (dibuat skrip bootstrap) tidak bisa dihapus.
 *   3. Bila collection ini kosong, mesin RBAC masuk mode bootstrap — lihat
 *      core/permissions.ts.
 */
export const buildRolesCollection = (
  opts: ResolvedOptions,
  collectionOptions: OptionObject[],
  globalOptions: OptionObject[],
): CollectionConfig => {

  const onChange = async (): Promise<void> => {
    await invalidatePermissions(opts)
  }

  const superAdminOnly = async ({ req }: { req: Parameters<typeof getPermissions>[0] }) => {
    if (!req?.user || (req.user as { collection?: string }).collection !== opts.authCollection) {
      return false
    }
    return (await getPermissions(req, opts)).superAdmin
  }

  // Field yang pilihannya kosong TIDAK boleh ikut dipasang. Pada Postgres,
  // `select` menjadi tipe enum; enum tanpa nilai tidak terlihat oleh pembanding
  // skema Payload, sehingga setiap boot mencoba membuatnya lagi dan gagal
  // permanen ("type already exists"). Proyek tanpa global memicu ini persis.
  const crudFields: Field[] = []
  if (collectionOptions.length) {
    crudFields.push(collectionPermissionsField(collectionOptions))
  }
  if (globalOptions.length) {
    crudFields.push(globalPermissionsField(globalOptions))
  }

  const tabs: Tab[] = []
  if (crudFields.length) {
    tabs.push({
      description:
        'Satu baris per collection/global yang boleh disentuh peran ini. Tanpa baris = ' +
        'tidak ada akses sama sekali. Izin dari peran induk sudah otomatis ikut, tidak ' +
        'perlu ditulis ulang. Akses per field diatur di dalam barisnya masing-masing.',
      fields: crudFields,
      label: 'Collection & Global',
    })
  }

  return {
    slug: opts.rolesSlug,
    access: {
      // Sengaja TIDAK memakai access RBAC biasa: hanya super admin yang boleh
      // menyentuh definisi izin. Kalau tidak, peran biasa yang kebetulan diberi
      // update pada collection ini bisa menaikkan haknya sendiri.
      create: superAdminOnly,
      delete: superAdminOnly,
      // Dibaca semua staf supaya dropdown peran di halaman user tetap terisi.
      read: ({ req }) =>
        Boolean(
          req?.user && (req.user as { collection?: string }).collection === opts.authCollection,
        ),
      update: superAdminOnly,
    },
    admin: {
      defaultColumns: ['name', 'slug', 'parent', 'isSuperAdmin', 'updatedAt'],
      description:
        'Peran dan hak aksesnya. Perubahan langsung berlaku setelah cache izin kedaluwarsa.',
      group: opts.adminGroup,
      useAsTitle: 'name',
    },
    fields: [
      {
        type: 'row',
        fields: [
          { name: 'name', type: 'text', admin: { width: '50%' }, required: true },
          {
            name: 'slug',
            type: 'text',
            admin: {
              description: 'Pengenal teknis. Jangan diubah bila sudah dipakai kode lain.',
              width: '50%',
            },
            hooks: {
              beforeValidate: [
                ({ data, value }) => {
                  const source =
                    typeof value === 'string' && value.trim() ? value : (data?.name ?? '')
                  return slugify(String(source))
                },
              ],
            },
            index: true,
            required: true,
            unique: true,
          },
        ],
      },
      {
        name: 'description',
        type: 'textarea',
        admin: {
          description: 'Untuk siapa peran ini, supaya admin lain tidak salah memberi akses.',
        },
      },
      {
        name: 'parent',
        type: 'relationship',
        admin: {
          description:
            'Peran ini mewarisi SELURUH izin induknya, lalu boleh menambah izin sendiri. ' +
            'Pewarisan berlaku berlapis dan hanya bisa menambah, tidak pernah mencabut.',
        },
        filterOptions: ({ id }) => (id ? { id: { not_equals: id } } : true),
        label: 'Mewarisi dari',
        relationTo: opts.rolesSlug as never,
      },
      {
        type: 'row',
        fields: [
          {
            name: 'isSuperAdmin',
            type: 'checkbox',
            admin: {
              description: 'Mengabaikan seluruh centang di bawah. Hanya untuk administrator sistem.',
              width: '50%',
            },
            defaultValue: false,
            label: 'Super Admin (akses penuh)',
          },
          {
            name: 'canAccessAdmin',
            type: 'checkbox',
            admin: { width: '50%' },
            defaultValue: true,
            label: 'Boleh membuka panel /admin',
          },
        ],
      },
      // Tab hanya muncul bila ada yang bisa diatur di dalamnya.
      ...(tabs.length ? [{ type: 'tabs', admin: { condition: (_, sibling) => !sibling?.isSuperAdmin }, tabs } as Field] : []),
      {
        name: 'isSystem',
        type: 'checkbox',
        admin: {
          description: 'Peran bawaan yang dibuat skrip bootstrap dan tidak boleh dihapus.',
          position: 'sidebar',
          readOnly: true,
        },
        defaultValue: false,
        label: 'Peran bawaan sistem',
      },
    ],
    hooks: {
      afterChange: [onChange],
      afterDelete: [onChange],
      beforeDelete: [
        async ({ id, req }) => {
          const doc = (await req.payload.findByID({
            id,
            collection: opts.rolesSlug as never,
            depth: 0,
            overrideAccess: true,
          })) as Record<string, unknown>

          if (doc.isSystem) {
            throw new Error('Peran bawaan sistem tidak dapat dihapus. Ubah izinnya bila perlu.')
          }

          if (doc.isSuperAdmin) {
            const { totalDocs } = await req.payload.count({
              collection: opts.rolesSlug as never,
              overrideAccess: true,
              where: {
                and: [{ isSuperAdmin: { equals: true } }, { id: { not_equals: id } }],
              },
            })
            if (totalDocs === 0) {
              throw new Error(
                'Ini satu-satunya peran Super Admin. Buat peran super admin lain sebelum menghapusnya.',
              )
            }
          }

          // Peran yang masih diwarisi peran lain tidak boleh hilang diam-diam:
          // turunannya akan kehilangan izin tanpa ada jejak perubahan.
          const children = await req.payload.count({
            collection: opts.rolesSlug as never,
            overrideAccess: true,
            where: { parent: { equals: id } },
          })
          if (children.totalDocs > 0) {
            throw new Error(
              `Peran ini masih menjadi induk dari ${children.totalDocs} peran lain. ` +
                'Pindahkan pewarisannya lebih dulu.',
            )
          }

          const inUse = await req.payload.count({
            collection: opts.authCollection as never,
            overrideAccess: true,
            where: { [opts.userRolesField]: { equals: id } },
          })
          if (inUse.totalDocs > 0) {
            throw new Error(
              `Peran ini masih dipakai ${inUse.totalDocs} pengguna. Lepaskan dulu dari mereka.`,
            )
          }
        },
      ],
      beforeValidate: [
        async ({ data, originalDoc, req }) => {
          const parent = data?.parent
          const selfId = originalDoc?.id
          if (!parent || !selfId) {
            return data
          }

          // Rantai pewarisan yang melingkar membuat resolusi izin tidak pernah
          // selesai. Ditolak di sini supaya data buruk tidak pernah tersimpan.
          const seen = new Set<string>([String(selfId)])
          let cursor: unknown = typeof parent === 'object' ? (parent as { id: unknown }).id : parent

          while (cursor !== null && cursor !== undefined) {
            const key = String(cursor)
            if (seen.has(key)) {
              throw new Error(
                'Pewarisan peran tidak boleh melingkar — peran ini sudah menjadi induk dari calon induknya.',
              )
            }
            seen.add(key)

            const ancestor = (await req.payload
              .findByID({
                id: cursor as string,
                collection: opts.rolesSlug as never,
                depth: 0,
                disableErrors: true,
                overrideAccess: true,
              })
              .catch(() => null)) as null | Record<string, unknown>

            if (!ancestor) {
              break
            }
            const next = ancestor.parent
            cursor =
              next && typeof next === 'object' ? (next as { id: unknown }).id : (next ?? null)
          }

          return data
        },
      ],
    },
    labels: { plural: 'Peran & Hak Akses', singular: 'Peran' },
  }
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * Kebijakan field untuk satu entitas.
 *
 * Ditempel LANGSUNG pada baris collection/global-nya, bukan sebagai daftar
 * terpisah. Kebijakan ini hanya bermakna bersama entitasnya; memisahkannya
 * memaksa orang menghubungkan dua daftar di kepala hanya untuk membaca satu
 * aturan.
 */
const fieldPolicyField = (): Field => ({
  name: 'fieldPolicy',
  type: 'select',
  admin: {
    description:
      'Menentukan nasib field yang TIDAK didaftarkan di tab Field untuk entitas ini.',
  },
  defaultValue: 'restrict',
  label: 'Field yang tidak didaftarkan',
  options: [
    { label: 'Boleh diubah (batasi hanya yang didaftarkan)', value: 'restrict' },
    { label: 'Tertutup (hanya yang didaftarkan yang boleh)', value: 'allowlist' },
  ],
})

/**
 * Pengaturan akses per field untuk SATU entitas, di dalam barisnya sendiri.
 *
 * Disimpan sebagai `json` (path field → tingkat akses), bukan array baris.
 * Dua alasan:
 *   1. Daftar pilihannya harus mengikuti collection yang dipilih di baris yang
 *      sama. Field `select` Payload punya daftar opsi yang tetap, jadi mustahil
 *      difilter per baris — pemilihnya harus komponen sendiri, dan komponen itu
 *      lebih mudah menyimpan satu objek daripada mengelola sub-array.
 *   2. `select` menjadi enum di Postgres. Daftar berisi seluruh field dari
 *      seluruh collection akan menjadi enum bernilai ribuan yang ikut berubah
 *      setiap kali ada field ditambah. `json` menjadi JSONB — tidak ada enum
 *      yang perlu dimigrasi.
 */
const fieldAccessField = (entityType: 'collection' | 'global'): Field => ({
  name: 'fieldAccess',
  type: 'json',
  admin: {
    components: { Field: 'payload-hrbac/client#FieldAccessControl' },
    custom: { payloadHrbacEntityType: entityType },
  },
  label: 'Akses per Field',
})

const collectionPermissionsField = (options: OptionObject[]): Field => ({
  name: 'collectionPermissions',
  type: 'array',
  admin: {
    components: { RowLabel: 'payload-hrbac/client#CollectionPermissionRowLabel' },
  },
  fields: [
    { name: 'collection', type: 'select', options, required: true },
    {
      type: 'row',
      fields: [
        { name: 'create', type: 'checkbox', admin: { width: '25%' }, defaultValue: false },
        { name: 'read', type: 'checkbox', admin: { width: '25%' }, defaultValue: true },
        { name: 'update', type: 'checkbox', admin: { width: '25%' }, defaultValue: false },
        { name: 'delete', type: 'checkbox', admin: { width: '25%' }, defaultValue: false },
      ],
    },
    {
      name: 'readVersions',
      type: 'checkbox',
      admin: { description: 'Dibutuhkan untuk melihat draft dan riwayat versi.' },
      defaultValue: false,
      label: 'Boleh melihat draft & versi lama',
    },
    fieldPolicyField(),
    fieldAccessField('collection'),
  ],
  label: 'Izin per Collection',
  labels: { plural: 'Izin Collection', singular: 'Izin Collection' },
})

const globalPermissionsField = (options: OptionObject[]): Field => ({
  name: 'globalPermissions',
  type: 'array',
  fields: [
    { name: 'global', type: 'select', options, required: true },
    {
      type: 'row',
      fields: [
        { name: 'read', type: 'checkbox', admin: { width: '50%' }, defaultValue: true },
        { name: 'update', type: 'checkbox', admin: { width: '50%' }, defaultValue: false },
      ],
    },
    fieldPolicyField(),
    fieldAccessField('global'),
  ],
  label: 'Izin per Global',
  labels: { plural: 'Izin Global', singular: 'Izin Global' },
})

