import type { PayloadHrbacCache } from '../types.js'

/**
 * Cache in-memory bawaan.
 *
 * Fungsi access dipanggil sangat sering (tiap operasi × tiap dokumen × tiap
 * field), jadi membaca matriks izin dari database setiap kali terlalu mahal.
 * Bawaan ini cukup untuk satu proses. Untuk deployment multi-instance pasang
 * `cache` sendiri (mis. Redis), supaya perubahan peran ikut membatalkan cache
 * di node lain — kalau tidak, node lain baru menyusul setelah TTL habis.
 *
 * HMR-safe: instance disimpan di globalThis karena Next me-reload module ini
 * berkali-kali saat dev, dan cache yang ikut ter-reset membuat setiap request
 * memukul database.
 */

type Entry = { expiresAt: number; value: string }

const globalStore = globalThis as unknown as { __payloadHrbacCache?: Map<string, Entry> }

const store = (): Map<string, Entry> => {
  if (!globalStore.__payloadHrbacCache) {
    globalStore.__payloadHrbacCache = new Map()
  }
  return globalStore.__payloadHrbacCache
}

export const createMemoryCache = (): PayloadHrbacCache => ({
  clear: async (keyPrefix) => {
    const map = store()
    for (const key of map.keys()) {
      if (key.startsWith(keyPrefix)) {
        map.delete(key)
      }
    }
    return Promise.resolve()
  },
  get: async (key) => {
    const entry = store().get(key)
    if (!entry) {
      return Promise.resolve(null)
    }
    if (entry.expiresAt <= Date.now()) {
      store().delete(key)
      return Promise.resolve(null)
    }
    return Promise.resolve(entry.value)
  },
  set: async (key, value, ttlSeconds) => {
    store().set(key, { expiresAt: Date.now() + ttlSeconds * 1000, value })
    return Promise.resolve()
  },
})

export const CACHE_PREFIX = 'payload-hrbac:'

export const matrixCacheKey = (rolesSlug: string, roleIds: (number | string)[]): string =>
  `${CACHE_PREFIX}${rolesSlug}:matrix:${roleIds.length ? [...roleIds].sort().join('-') : 'none'}`

export const rolesCacheKey = (rolesSlug: string): string => `${CACHE_PREFIX}${rolesSlug}:all`
