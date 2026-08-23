import type { PayloadRequest } from 'payload'

import type { PermissionMatrix, ResolvedOptions } from '../types.js'
import type { RoleDoc } from './matrix.js'

import { CACHE_PREFIX, matrixCacheKey, rolesCacheKey } from './cache.js'
import { emptyMatrix, mergeRoles, resolveAssignedRoles, superAdminMatrix } from './matrix.js'

/**
 * Pengambilan matriks izin milik user yang sedang login.
 *
 * Tiga lapis, karena fungsi access dipanggil sangat sering (tiap operasi × tiap
 * dokumen × tiap field):
 *   1. Per-request (`req.context`) — nol I/O untuk pemanggilan berikutnya dalam
 *      request yang sama. Ini lapis yang paling banyak menghemat.
 *   2. Cache (bawaan in-memory, TTL 60s) — konsisten lintas request.
 *   3. Database — sumber kebenaran.
 *
 * Kegagalan cache TIDAK PERNAH membuka akses: bila lapis 2 error, kita jatuh ke
 * database, bukan ke "izinkan saja".
 */

const REQUEST_CACHE_KEY = '__payloadHrbacMatrix'

/** Ambil daftar id peran dari dokumen user, baik ter-populate maupun belum. */
export const extractRoleIds = (user: unknown, rolesField: string): (number | string)[] => {
  const raw = (user as null | Record<string, unknown>)?.[rolesField]
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]

  return list
    .map((entry) =>
      entry && typeof entry === 'object'
        ? (entry as { id?: number | string }).id
        : (entry as number | string),
    )
    .filter((id): id is number | string => id !== undefined && id !== null)
}

/** True bila user berasal dari collection auth yang dikelola RBAC ini. */
export const isManagedUser = (user: unknown, authCollection: string): boolean =>
  Boolean(user && (user as { collection?: string }).collection === authCollection)

export const getPermissions = async (
  req: PayloadRequest,
  opts: ResolvedOptions,
): Promise<PermissionMatrix> => {
  const user = req?.user
  if (!isManagedUser(user, opts.authCollection)) {
    return emptyMatrix()
  }

  const ctx = (req.context ?? {}) as Record<string, unknown>
  const perRequest = ctx[REQUEST_CACHE_KEY] as PermissionMatrix | undefined
  if (perRequest) {
    return perRequest
  }

  const roleIds = extractRoleIds(user, opts.userRolesField)
  const cacheKey = matrixCacheKey(opts.rolesSlug, roleIds)

  try {
    const hit = await opts.cache.get(cacheKey)
    if (hit) {
      const matrix = JSON.parse(hit) as PermissionMatrix
      ctx[REQUEST_CACHE_KEY] = matrix
      return matrix
    }
  } catch {
    // Cache bermasalah bukan alasan menolak akses — baca saja dari database.
  }

  const matrix = await buildMatrix(req, opts, roleIds)

  try {
    await opts.cache.set(cacheKey, JSON.stringify(matrix), opts.cacheTTLSeconds)
  } catch {
    // Cache bersifat opsional.
  }
  ctx[REQUEST_CACHE_KEY] = matrix
  return matrix
}

/**
 * Seluruh peran dimuat sekaligus, bukan hanya milik user.
 *
 * Pewarisan butuh peran induk, dan induk bisa berlapis; mengambilnya satu per
 * satu berarti N query berantai per cache miss. Jumlah peran pada praktiknya
 * puluhan, jadi satu query untuk semuanya jauh lebih murah.
 */
const loadAllRoles = async (req: PayloadRequest, opts: ResolvedOptions): Promise<RoleDoc[]> => {
  const key = rolesCacheKey(opts.rolesSlug)

  try {
    const hit = await opts.cache.get(key)
    if (hit) {
      return JSON.parse(hit) as RoleDoc[]
    }
  } catch {
    /* lanjut ke database */
  }

  const { docs } = await req.payload.find({
    collection: opts.rolesSlug as never,
    depth: 0,
    limit: 1000,
    overrideAccess: true,
    pagination: false,
  })

  try {
    await opts.cache.set(key, JSON.stringify(docs), opts.cacheTTLSeconds)
  } catch {
    /* opsional */
  }

  return docs as unknown as RoleDoc[]
}

const buildMatrix = async (
  req: PayloadRequest,
  opts: ResolvedOptions,
  roleIds: (number | string)[],
): Promise<PermissionMatrix> => {
  const all = await loadAllRoles(req, opts)

  if (all.length === 0) {
    if (!opts.bootstrapSuperAdmin) {
      return emptyMatrix()
    }
    // Instalasi baru: tanpa ini, memasang plugin akan langsung mengunci semua
    // orang dari /admin dan tidak ada cara membuat peran pertama lewat GUI.
    req.payload.logger.warn(
      `[payload-hrbac] Collection \`${opts.rolesSlug}\` masih kosong — pengguna ` +
        `\`${opts.authCollection}\` yang login diperlakukan sebagai super admin. ` +
        'Buat minimal satu peran untuk mematikan mode ini.',
    )
    return superAdminMatrix(true)
  }

  if (!roleIds.length) {
    // Penyebab paling sering orang "tiba-tiba terkunci": peran pertama dibuat,
    // mode bootstrap mati, dan pengguna lama belum ditautkan ke peran mana pun.
    // Tanpa pesan ini gejalanya cuma 403 tanpa keterangan.
    req.payload.logger.warn(
      `[payload-hrbac] Pengguna \`${opts.authCollection}\` yang login belum punya peran, ` +
        'sehingga tidak punya akses apa pun. Tetapkan perannya, atau jalankan `bootstrapRoles()`.',
    )
    return emptyMatrix()
  }

  const byId = new Map(all.map((role) => [String(role.id), role]))
  return mergeRoles(resolveAssignedRoles(roleIds, byId))
}

/** Buang cache izin. Dipanggil otomatis oleh hook collection `roles`. */
export const invalidatePermissions = async (opts: ResolvedOptions): Promise<void> => {
  try {
    await opts.cache.clear(CACHE_PREFIX)
  } catch {
    // Cache akan kedaluwarsa sendiri setelah TTL.
  }
}
