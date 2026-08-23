import type { Access, FieldAccess, PayloadRequest } from 'payload'

import type {
  CollectionAction,
  FieldAction,
  GlobalAction,
  PayloadHrbacPluginConfig,
  ResolvedOptions,
} from './types.js'

import { createMemoryCache } from './core/cache.js'
import { entityKey, fieldKey } from './core/fieldPaths.js'
import {
  collectionPermissionFor,
  fieldPermissionFor,
  globalPermissionFor,
} from './core/matrix.js'
import { getPermissions, isManagedUser } from './core/permissions.js'

/**
 * Helper untuk dipakai DI LUAR access control yang dipasang plugin — route
 * handler, hook, komponen server, atau collection yang sengaja tidak dikelola
 * plugin tapi tetap ingin mengikuti peran yang sama.
 *
 * Opsi yang dioper harus sama dengan yang dipakai saat memasang plugin, karena
 * dari situlah nama collection auth dan slug peran dibaca. Cache bawaan berbagi
 * penyimpanan yang sama dengan plugin, jadi tidak ada duplikasi query.
 */
export const createPayloadHrbacHelpers = (pluginOptions: PayloadHrbacPluginConfig = {}) => {
  const opts: ResolvedOptions = {
    adminGroup: pluginOptions.adminGroup ?? 'System',
    authCollection: pluginOptions.authCollection ?? 'users',
    bootstrapSuperAdmin: pluginOptions.bootstrapSuperAdmin ?? true,
    cache: pluginOptions.cache ?? createMemoryCache(),
    cacheTTLSeconds: pluginOptions.cacheTTLSeconds ?? 60,
    enforceAdminAccess: pluginOptions.enforceAdminAccess ?? true,
    enforceCollectionAccess: pluginOptions.enforceCollectionAccess ?? true,
    enforceFieldAccess: pluginOptions.enforceFieldAccess ?? true,
    rolesSlug: pluginOptions.rolesSlug ?? 'roles',
    userRolesField: pluginOptions.userRolesField ?? 'roles',
  }

  /** Matriks izin milik request saat ini. */
  const permissions = (req: PayloadRequest) => getPermissions(req, opts)

  /** Bolehkah user melakukan aksi ini pada collection tersebut? */
  const can = async (
    req: PayloadRequest,
    collectionSlug: string,
    action: CollectionAction,
  ): Promise<boolean> => {
    if (!isManagedUser(req?.user, opts.authCollection)) {
      return false
    }
    return collectionPermissionFor(await permissions(req), collectionSlug)[action]
  }

  const canGlobal = async (
    req: PayloadRequest,
    globalSlug: string,
    action: GlobalAction,
  ): Promise<boolean> => {
    if (!isManagedUser(req?.user, opts.authCollection)) {
      return false
    }
    return globalPermissionFor(await permissions(req), globalSlug)[action]
  }

  const canField = async (
    req: PayloadRequest,
    entityType: 'collection' | 'global',
    entitySlug: string,
    path: string,
    action: FieldAction,
  ): Promise<boolean> => {
    if (!isManagedUser(req?.user, opts.authCollection)) {
      return false
    }
    const matrix = await permissions(req)
    return fieldPermissionFor(
      matrix,
      entityKey(entityType, entitySlug),
      fieldKey(entityType, entitySlug, path),
    )[action]
  }

  const isSuperAdmin = async (req: PayloadRequest): Promise<boolean> =>
    isManagedUser(req?.user, opts.authCollection) && (await permissions(req)).superAdmin

  /** Punya peran ini (langsung maupun lewat pewarisan)? */
  const hasRole = async (req: PayloadRequest, slug: string): Promise<boolean> => {
    if (!isManagedUser(req?.user, opts.authCollection)) {
      return false
    }
    const matrix = await permissions(req)
    return matrix.superAdmin || matrix.roleSlugs.includes(slug)
  }

  /** `access` siap pakai untuk membatasi sesuatu ke super admin saja. */
  const superAdminOnly: Access = async ({ req }) => isSuperAdmin(req)

  const superAdminOnlyField: FieldAccess = async ({ req }) => isSuperAdmin(req)

  /** `access` yang menuntut peran tertentu. */
  const requireRole =
    (slug: string): Access =>
    async ({ req }) =>
      hasRole(req, slug)

  return {
    can,
    canField,
    canGlobal,
    hasRole,
    isSuperAdmin,
    options: opts,
    permissions,
    requireRole,
    superAdminOnly,
    superAdminOnlyField,
  }
}
