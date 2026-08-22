import type { Config, Field, OptionObject } from 'payload'

import type {
  EntityFieldInfo,
  PayloadRbacPluginConfig,
  PluginFactory,
  ResolvedOptions,
} from './types.js'

import { applyFieldAccess, buildCollectionAccess, buildGlobalAccess } from './access/enforce.js'
import { buildRolesCollection } from './collections/roles.js'
import { createMemoryCache } from './core/cache.js'
import { collectFieldPaths, entityKey } from './core/fieldPaths.js'
import { getPermissions } from './core/permissions.js'

export * from './bootstrap.js'
export { createMemoryCache } from './core/cache.js'
export { collectFieldPaths, entityKey, fieldKey } from './core/fieldPaths.js'
export {
  collectionPermissionFor,
  fieldPermissionFor,
  globalPermissionFor,
  mergeRoles,
} from './core/matrix.js'
export { getPermissions, invalidatePermissions, isManagedUser } from './core/permissions.js'
export * from './helpers.js'
export * from './types.js'

/**
 * payload-rbac — Dynamic Nested RBAC untuk Payload CMS.
 *
 * "Dynamic" karena daftar collection, global, dan FIELD yang bisa diatur
 * ditemukan sendiri dari config saat boot — tidak ada registry yang harus
 * dirawat manual, dan menambah collection baru langsung memunculkan pilihan
 * izinnya di panel admin.
 *
 * "Nested" dalam dua arti: peran bisa mewarisi peran lain secara berlapis, dan
 * izin bisa turun sampai ke field di dalam group/array/blocks/tab.
 *
 * Plugin hanya MEMPERSEMPIT akses. Access control milik host tetap dijalankan
 * dan hasilnya diiriskan, jadi memasang plugin ini tidak bisa membuka data yang
 * sebelumnya tertutup.
 */
export const payloadRbac =
  (pluginOptions: PayloadRbacPluginConfig = {}): PluginFactory =>
  (config: Config): Config => {
    const opts = resolveOptions(pluginOptions, config)

    const managedCollections = pickSlugs(
      (config.collections ?? []).map((c) => c.slug),
      pluginOptions.collections,
      [...(pluginOptions.excludeCollections ?? []), opts.rolesSlug],
    )
    const managedGlobals = pickSlugs(
      (config.globals ?? []).map((g) => g.slug),
      pluginOptions.globals,
      pluginOptions.excludeGlobals ?? [],
    )

    const label = (slug: string): string =>
      pluginOptions.entityLabels?.[slug] ?? humanize(slug)

    const collectionOptions: OptionObject[] = managedCollections.map((slug) => ({
      label: label(slug),
      value: slug,
    }))
    const globalOptions: OptionObject[] = managedGlobals.map((slug) => ({
      label: label(slug),
      value: slug,
    }))

    // Entitas yang izin field-nya diekspos di dropdown. Dibatasi terpisah dari
    // izin CRUD karena jumlah opsinya berlipat: satu proyek menengah mudah
    // punya ribuan field, dan dropdown sepanjang itu tidak lagi bisa dipakai.
    const fieldEntities = new Set(
      pluginOptions.fieldPermissionEntities ?? [...managedCollections, ...managedGlobals],
    )

    /**
     * Daftar field per entitas — BUKAN satu daftar datar berisi semua field.
     *
     * Dibentuk begini karena pemilihnya nanti berada DI DALAM baris
     * collection-nya: saat baris `pages` dibuka, yang muncul hanya field milik
     * `pages`. Daftar datar memaksa orang mencari di antara ribuan field dari
     * collection yang tidak sedang mereka atur.
     */
    const entityFields: Record<string, EntityFieldInfo[]> = {}
    const collectFor = (
      entityType: 'collection' | 'global',
      slug: string,
      fields: Field[],
    ): void => {
      if (!fieldEntities.has(slug)) {
        return
      }
      const paths = collectFieldPaths(fields)
      if (paths.length) {
        entityFields[entityKey(entityType, slug)] = paths.map((info) => ({
          type: info.type,
          label: info.label,
          path: info.path,
        }))
      }
    }

    for (const collection of config.collections ?? []) {
      if (managedCollections.includes(collection.slug)) {
        collectFor('collection', collection.slug, collection.fields ?? [])
      }
    }
    for (const global of config.globals ?? []) {
      if (managedGlobals.includes(global.slug)) {
        collectFor('global', global.slug, global.fields ?? [])
      }
    }

    // Komponen client pemilih field membacanya lewat `useConfig()`; daftar ini
    // tidak berubah saat runtime, jadi aman dibekukan bersama config.
    config.admin = config.admin ?? {}
    config.admin.custom = {
      ...config.admin.custom,
      payloadRbac: { ...(config.admin.custom?.payloadRbac as object), entityFields },
    }

    config.collections = [
      ...(config.collections ?? []),
      buildRolesCollection(opts, collectionOptions, globalOptions),
    ]

    // Field relasi peran pada collection auth. Ditambahkan bahkan saat plugin
    // dinonaktifkan, supaya skema database tetap sama dan migrasi tidak pecah.
    attachRolesField(config, opts)

    if (pluginOptions.disabled) {
      return config
    }

    const excludedFieldPaths = new Set(pluginOptions.excludeFieldPaths ?? [])

    config.collections = config.collections.map((collection) => {
      if (!managedCollections.includes(collection.slug)) {
        return collection
      }

      const next = { ...collection }

      if (opts.enforceCollectionAccess) {
        next.access = buildCollectionAccess(collection, opts)
      }
      if (opts.enforceFieldAccess) {
        next.fields = applyFieldAccess(
          collection.fields ?? [],
          'collection',
          collection.slug,
          opts,
          excludedFieldPaths,
        )
      }

      return next
    })

    config.globals = (config.globals ?? []).map((global) => {
      if (!managedGlobals.includes(global.slug)) {
        return global
      }

      const next = { ...global }

      if (opts.enforceCollectionAccess) {
        next.access = buildGlobalAccess(global, opts)
      }
      if (opts.enforceFieldAccess) {
        next.fields = applyFieldAccess(
          global.fields ?? [],
          'global',
          global.slug,
          opts,
          excludedFieldPaths,
        )
      }

      return next
    })

    if (opts.enforceAdminAccess) {
      attachAdminAccess(config, opts)
    }

    return config
  }

const humanize = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase())

/**
 * Collection internal Payload (`payload-preferences`, `payload-jobs`, …) tidak
 * pernah dikelola: menutupnya akan merusak panel admin, dan tidak ada admin yang
 * ingin mengatur izin ke sana lewat GUI.
 */
const isInternal = (slug: string): boolean => slug.startsWith('payload-')

const pickSlugs = (
  available: string[],
  include: string[] | undefined,
  exclude: string[],
): string[] => {
  const excluded = new Set(exclude)
  return available.filter(
    (slug) =>
      !isInternal(slug) && !excluded.has(slug) && (include ? include.includes(slug) : true),
  )
}

const resolveOptions = (
  pluginOptions: PayloadRbacPluginConfig,
  config: Config,
): ResolvedOptions => ({
  adminGroup: pluginOptions.adminGroup ?? 'System',
  authCollection: pluginOptions.authCollection ?? config.admin?.user ?? 'users',
  bootstrapSuperAdmin: pluginOptions.bootstrapSuperAdmin ?? true,
  cache: pluginOptions.cache ?? createMemoryCache(),
  cacheTTLSeconds: pluginOptions.cacheTTLSeconds ?? 60,
  enforceAdminAccess: pluginOptions.enforceAdminAccess ?? true,
  enforceCollectionAccess: pluginOptions.enforceCollectionAccess ?? true,
  enforceFieldAccess: pluginOptions.enforceFieldAccess ?? true,
  rolesSlug: pluginOptions.rolesSlug ?? 'roles',
  userRolesField: pluginOptions.userRolesField ?? 'roles',
})

const attachRolesField = (config: Config, opts: ResolvedOptions): void => {
  const auth = (config.collections ?? []).find((c) => c.slug === opts.authCollection)
  if (!auth) {
    throw new Error(
      `[payload-rbac] Collection auth \`${opts.authCollection}\` tidak ditemukan di config. ` +
        'Set opsi `authCollection` ke slug yang benar.',
    )
  }

  const already = (auth.fields ?? []).some(
    (f) => (f as { name?: string }).name === opts.userRolesField,
  )
  if (already) {
    return
  }

  auth.fields = [
    ...(auth.fields ?? []),
    {
      name: opts.userRolesField,
      type: 'relationship',
      access: {
        // Kalau tidak dikunci, siapa pun yang boleh mengubah user bisa memberi
        // dirinya sendiri peran super admin — RBAC-nya jadi tidak ada artinya.
        create: async ({ req }) => (await getPermissions(req, opts)).superAdmin,
        update: async ({ req }) => (await getPermissions(req, opts)).superAdmin,
      },
      admin: { description: 'Izin bersifat aditif: user memperoleh gabungan izin seluruh perannya.' },
      hasMany: true,
      index: true,
      label: 'Peran',
      relationTo: opts.rolesSlug as never,
    } as Field,
  ]
}

const attachAdminAccess = (config: Config, opts: ResolvedOptions): void => {
  const auth = (config.collections ?? []).find((c) => c.slug === opts.authCollection)
  if (!auth) {
    return
  }

  const existing = auth.access?.admin
  auth.access = {
    ...auth.access,
    admin: async (args) => {
      const matrix = await getPermissions(args.req, opts)
      if (!matrix.canAccessAdmin) {
        return false
      }
      return existing ? await existing(args) : true
    },
  }
}
