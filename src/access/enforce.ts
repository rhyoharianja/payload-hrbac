import type { Access, CollectionConfig, Field, FieldAccess, GlobalConfig } from 'payload'

import type { EntityType, ResolvedOptions } from '../types.js'

import {
  blockPrefix,
  containerPrefix,
  entityKey,
  fieldKey,
  isPermissionable,
  tabPrefix,
} from '../core/fieldPaths.js'
import {
  collectionPermissionFor,
  fieldPermissionFor,
  globalPermissionFor,
} from '../core/matrix.js'
import { getPermissions, isManagedUser } from '../core/permissions.js'

/**
 * Pemasangan access control ke config yang sudah ada.
 *
 * Prinsip yang dipegang di seluruh file ini: plugin hanya MEMPERSEMPIT, tidak
 * pernah memperlebar. Access bawaan milik host selalu dijalankan lebih dulu, dan
 * hasil akhirnya adalah irisan keduanya. Dengan begitu memasang plugin tidak
 * bisa diam-diam membuka data yang sebelumnya tertutup.
 */

/** Gabungkan hasil access bawaan dengan keputusan RBAC (AND). */
const intersect = async (
  existing: Access | undefined,
  args: Parameters<Access>[0],
  rbac: () => Promise<boolean>,
): Promise<ReturnType<Access>> => {
  const allowed = await rbac()
  if (!allowed) {
    return false
  }
  if (!existing) {
    return true
  }

  const base = await existing(args)
  return base
}

export const buildCollectionAccess = (
  collection: CollectionConfig,
  opts: ResolvedOptions,
): CollectionConfig['access'] => {
  const slug = collection.slug
  const existing = collection.access ?? {}

  const gate =
    (action: 'create' | 'delete' | 'read' | 'readVersions' | 'update'): Access =>
    async (args) =>
      intersect(existing[action], args, async () => {
        // Pengguna non-staf (publik, atau collection auth lain) tidak diatur
        // matriks ini. Serahkan sepenuhnya ke access bawaan host.
        if (!isManagedUser(args.req?.user, opts.authCollection)) {
          return true
        }
        return collectionPermissionFor(await getPermissions(args.req, opts), slug)[action]
      })

  return {
    ...existing,
    create: gate('create'),
    delete: gate('delete'),
    read: gate('read'),
    readVersions: gate('readVersions'),
    update: gate('update'),
  }
}

export const buildGlobalAccess = (
  global: GlobalConfig,
  opts: ResolvedOptions,
): GlobalConfig['access'] => {
  const slug = global.slug
  const existing = global.access ?? {}

  const gate =
    (action: 'read' | 'update'): Access =>
    async (args) =>
      intersect(existing[action], args, async () => {
        if (!isManagedUser(args.req?.user, opts.authCollection)) {
          return true
        }
        return globalPermissionFor(await getPermissions(args.req, opts), slug)[action]
      })

  return {
    ...existing,
    read: gate('read'),
    update: gate('update'),
  }
}

/**
 * Access untuk satu field.
 *
 * Hanya berlaku bagi pengguna collection auth yang dikelola. Untuk pembaca
 * publik plugin tidak ikut campur: menolak di sini akan menghilangkan field dari
 * API publik tanpa pernah diminta, sementara yang mau dibatasi admin adalah
 * "siapa di antara staf yang boleh mengubah field ini".
 */
const buildFieldAccess = (
  existing: FieldAccess | undefined,
  entity: string,
  key: string,
  action: 'create' | 'read' | 'update',
  opts: ResolvedOptions,
): FieldAccess => {
  return async (args) => {
    if (!isManagedUser(args.req?.user, opts.authCollection)) {
      return existing ? await existing(args) : true
    }
    const matrix = await getPermissions(args.req, opts)
    if (!fieldPermissionFor(matrix, entity, key)[action]) {
      return false
    }
    return existing ? await existing(args) : true
  }
}

type AnyField = Field & Record<string, unknown>

/**
 * Pasang access RBAC ke setiap field bernama, secara rekursif.
 *
 * Aturan path DIPINJAM dari `branchesOf`/`isPermissionable` — modul yang sama
 * yang menyusun daftar pilihan di editor peran. Selama keduanya memanggil
 * fungsi itu, path yang dicentang admin dijamin cocok dengan field yang
 * ditegakkan di sini.
 *
 * Mengembalikan array baru; field aslinya tidak dimutasi supaya config milik
 * host aman dipakai ulang (mis. field yang di-share antar collection).
 */
export const applyFieldAccess = (
  fields: Field[],
  entityType: EntityType,
  entitySlug: string,
  opts: ResolvedOptions,
  excluded: Set<string>,
  pathPrefix = '',
): Field[] => {
  const entity = entityKey(entityType, entitySlug)

  return fields.map((raw) => {
    const field = { ...(raw as AnyField) } as AnyField

    if (isPermissionable(field)) {
      const path = pathPrefix ? `${pathPrefix}.${String(field.name)}` : String(field.name)
      const key = fieldKey(entityType, entitySlug, path)

      if (!excluded.has(key)) {
        const existing = (field.access ?? {}) as Record<string, FieldAccess | undefined>
        field.access = {
          ...existing,
          create: buildFieldAccess(existing.create, entity, key, 'create', opts),
          read: buildFieldAccess(existing.read, entity, key, 'read', opts),
          update: buildFieldAccess(existing.update, entity, key, 'update', opts),
        }
      }
    }

    // Turun ke anak-anaknya. Prefix dihitung lewat helper yang sama dengan
    // penyusun daftar path, jadi keduanya tidak bisa berbeda.
    const inner = containerPrefix(field, pathPrefix)
    const recurse = (children: Field[], prefix: string): Field[] =>
      applyFieldAccess(children, entityType, entitySlug, opts, excluded, prefix)

    switch (field.type) {
      case 'array':
      case 'collapsible':
      case 'group':
      case 'row':
        field.fields = recurse((field.fields ?? []), inner)
        break

      case 'blocks':
        field.blocks = ((field.blocks ?? []) as unknown[]).map((block) => {
          // Slug string (blockReferences) tidak membawa definisi field di sini.
          if (!block || typeof block !== 'object') {
            return block
          }
          const typed = block as { fields?: Field[]; slug: string }
          return {
            ...typed,
            fields: recurse(typed.fields ?? [], blockPrefix(typed.slug, inner)),
          }
        }) as never
        break

      case 'tabs':
        field.tabs = ((field.tabs ?? []) as Record<string, unknown>[]).map((tab) => ({
          ...tab,
          fields: recurse((tab.fields ?? []) as Field[], tabPrefix(tab, inner)),
        })) as never
        break

      default:
        break
    }

    return field as Field
  })
}
