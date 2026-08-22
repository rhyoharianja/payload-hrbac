import type { Field } from 'payload'

import type { EntityType } from '../types.js'

/**
 * Penelusuran pohon field.
 *
 * Dipakai dua kali dengan aturan path yang HARUS identik:
 *   1. `collectFieldPaths` — menyusun pilihan dropdown di editor peran.
 *   2. `applyFieldAccess` (access/enforce.ts) — memasang `access` ke field aslinya.
 * Kalau keduanya berbeda satu karakter saja, izin yang dicentang admin tidak
 * akan pernah cocok dengan field yang ditegakkan. Karena itu aturan path hanya
 * ditulis di satu tempat: `containerPrefix`, `tabPrefix`, dan `blockPrefix`.
 *
 * Bentuk path:
 *   hero.title             — group / named tab
 *   links.label            — array (indeks tidak ikut: izin berlaku untuk
 *                            seluruh baris, bukan baris tertentu)
 *   layout.cta.heading     — blocks: `<namaField>.<slugBlock>.<field>`
 * Wadah tanpa nama (row, collapsible, tabs, unnamed tab/group) transparan —
 * anaknya memakai prefix milik induk terdekat yang bernama.
 */

export type FieldPathInfo = {
  /** Label yang dilihat admin, mis. `Hero › CTA › Label`. */
  label: string
  /** Path titik, mis. `hero.cta.label`. */
  path: string
  /** Tipe field Payload, ditampilkan sebagai petunjuk di dropdown. */
  type: string
}

type AnyField = Field & Record<string, unknown>

/** Field yang tidak punya nilai tersimpan, jadi tidak ada gunanya diberi izin. */
const PRESENTATIONAL = new Set(['collapsible', 'row', 'tabs', 'ui'])

/**
 * Field auth & sistem bawaan Payload. Menutup ini lewat RBAC akan merusak login
 * atau panel admin, dan bukan itu yang dimaksud admin saat mengatur izin field.
 */
export const RESERVED_FIELD_NAMES = new Set([
  '_verificationToken',
  '_verified',
  'apiKey',
  'apiKeyIndex',
  'createdAt',
  'enableAPIKey',
  'hash',
  'id',
  'lockUntil',
  'loginAttempts',
  'resetPasswordExpiration',
  'resetPasswordToken',
  'salt',
  'sessions',
  'updatedAt',
])

const humanize = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase())

const fieldLabel = (field: AnyField): string => {
  const label = field.label
  if (typeof label === 'string' && label) {
    return label
  }
  // Label terlokalisasi: ambil bahasa apa pun yang ada, sekadar untuk tampilan.
  if (label && typeof label === 'object') {
    const first = Object.values(label as Record<string, unknown>).find((v) => typeof v === 'string')
    if (typeof first === 'string') {
      return first
    }
  }
  return humanize(String(field.name ?? ''))
}

const childPath = (prefix: string, name: string): string => (prefix ? `${prefix}.${name}` : name)

const childLabel = (prefix: string, label: string): string =>
  prefix ? `${prefix} › ${label}` : label

/** Anak-anak sebuah field beserta prefix yang berlaku untuk mereka. */
type Branch = { fields: Field[]; labelPrefix: string; pathPrefix: string }

/**
 * Prefix path untuk anak-anak sebuah wadah. Satu-satunya tempat aturan
 * "wadah bernama menambah segmen, wadah tanpa nama transparan" ditulis —
 * dipakai baik saat menyusun daftar path maupun saat memasang access.
 */
export const containerPrefix = (field: AnyField, pathPrefix: string): string =>
  typeof field.name === 'string' && field.name.length > 0
    ? childPath(pathPrefix, field.name)
    : pathPrefix

/** Prefix untuk field di dalam sebuah tab. */
export const tabPrefix = (tab: Record<string, unknown>, pathPrefix: string): string =>
  typeof tab.name === 'string' && tab.name.length > 0
    ? childPath(pathPrefix, tab.name)
    : pathPrefix

/** Prefix untuk field di dalam satu block. */
export const blockPrefix = (blockSlug: string, containerPath: string): string =>
  childPath(containerPath, blockSlug)

/**
 * Turunkan cabang-cabang di bawah sebuah field. Mengembalikan array karena
 * `tabs` dan `blocks` bercabang lebih dari satu.
 */
export const branchesOf = (
  field: AnyField,
  pathPrefix: string,
  labelPrefix: string,
): Branch[] => {
  const named = typeof field.name === 'string' && field.name.length > 0
  const nextPath = containerPrefix(field, pathPrefix)
  const nextLabel = named ? childLabel(labelPrefix, fieldLabel(field)) : labelPrefix

  switch (field.type) {
    case 'array':
    case 'collapsible':
    case 'group':
    case 'row':
      return [
        { fields: (field.fields ?? []), labelPrefix: nextLabel, pathPrefix: nextPath },
      ]

    case 'blocks': {
      // `blocks` boleh berisi objek block ATAU slug string (blockReferences,
      // block yang didefinisikan di level config). Yang berupa string tidak
      // punya field untuk ditelusuri dari sini.
      const blocks = (field.blocks ?? []) as unknown[]
      return blocks.flatMap((block) => {
        if (!block || typeof block !== 'object') {
          return []
        }
        const { slug, fields } = block as { fields?: Field[]; slug: string }
        return [
          {
            fields: fields ?? [],
            labelPrefix: childLabel(nextLabel, humanize(slug)),
            pathPrefix: blockPrefix(slug, nextPath),
          },
        ]
      })
    }

    case 'tabs': {
      const tabs = (field.tabs ?? []) as ({ fields?: Field[] } & Record<string, unknown>)[]
      return tabs.map((tab) => {
        const tabNamed = typeof tab.name === 'string' && tab.name.length > 0
        return {
          fields: tab.fields ?? [],
          labelPrefix: tabNamed
            ? childLabel(nextLabel, fieldLabel(tab as AnyField))
            : nextLabel,
          pathPrefix: tabPrefix(tab, nextPath),
        }
      })
    }

    default:
      return []
  }
}

/** True bila field menyimpan nilai dan karenanya layak diberi izin sendiri. */
export const isPermissionable = (field: AnyField): boolean =>
  !PRESENTATIONAL.has(field.type) &&
  typeof field.name === 'string' &&
  field.name.length > 0 &&
  !RESERVED_FIELD_NAMES.has(field.name)

export const collectFieldPaths = (
  fields: Field[],
  pathPrefix = '',
  labelPrefix = '',
): FieldPathInfo[] => {
  const out: FieldPathInfo[] = []

  for (const raw of fields) {
    const field = raw as AnyField

    if (isPermissionable(field)) {
      out.push({
        type: field.type,
        label: childLabel(labelPrefix, fieldLabel(field)),
        path: childPath(pathPrefix, field.name as string),
      })
    }

    for (const branch of branchesOf(field, pathPrefix, labelPrefix)) {
      out.push(...collectFieldPaths(branch.fields, branch.pathPrefix, branch.labelPrefix))
    }
  }

  return out
}

/** Kunci gabungan yang dipakai sebagai nilai dropdown dan kunci matriks. */
export const fieldKey = (entityType: EntityType, entitySlug: string, path: string): string =>
  `${entityType}:${entitySlug}:${path}`

export const entityKey = (entityType: EntityType, entitySlug: string): string =>
  `${entityType}:${entitySlug}`
