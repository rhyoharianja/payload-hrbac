'use client'

import type { JSONFieldClientComponent } from 'payload'

import {
  Drawer,
  DrawerToggler,
  FieldLabel,
  useConfig,
  useDrawerSlug,
  useField,
  useFormFields,
} from '@payloadcms/ui'
import React from 'react'

import './FieldAccessControl.css'

import type { EntityFieldInfo, FieldAccessLevel, FieldAccessMap } from '../types.js'

/**
 * Pengatur akses per field, di dalam baris collection/global-nya sendiri.
 *
 * Daftar yang ditampilkan MENGIKUTI entitas yang dipilih di baris yang sama —
 * membuka baris `pages` hanya memperlihatkan field milik `pages`. Itulah alasan
 * komponen ini ada: field `select` bawaan Payload punya daftar opsi yang tetap
 * dan tidak bisa difilter per baris, sehingga satu-satunya alternatif adalah
 * satu daftar datar berisi seluruh field dari seluruh collection.
 *
 * Yang disimpan hanya PENGECUALIAN: field yang tidak disebut mengikuti
 * kebijakan pada baris yang sama, jadi baris tanpa pengecualian tetap kosong.
 */

const LEVELS: { hint: string; label: string; value: FieldAccessLevel }[] = [
  { hint: 'Bisa dibaca dan diisi', label: 'Boleh ubah', value: 'edit' },
  { hint: 'Terlihat, tidak bisa diisi', label: 'Hanya baca', value: 'readonly' },
  { hint: 'Tidak muncul sama sekali', label: 'Tersembunyi', value: 'hidden' },
]

const SUMMARY: Record<FieldAccessLevel, string> = {
  edit: 'boleh ubah',
  hidden: 'tersembunyi',
  readonly: 'hanya baca',
}

/** `collectionPermissions.0.fieldAccess` → `collectionPermissions.0.collection` */
const siblingPath = (path: string, name: string): string =>
  `${path.split('.').slice(0, -1).join('.')}.${name}`

export const FieldAccessControl: JSONFieldClientComponent = ({ field, path }) => {
  const { config } = useConfig()
  const { setValue, value } = useField<FieldAccessMap>({ path })
  const drawerSlug = useDrawerSlug(`payloadRbac-fields-${path}`)
  const [query, setQuery] = React.useState('')

  const entityType =
    ((field?.admin?.custom as { payloadRbacEntityType?: string } | undefined)?.payloadRbacEntityType ??
      'collection') as 'collection' | 'global'

  // Nilai entitas dibaca dari baris yang SAMA, bukan dari state komponen ini:
  // mengganti collection di baris itu harus langsung mengganti daftar fieldnya.
  const entitySlug = useFormFields(([fields]) => {
    const sibling = fields?.[siblingPath(path, entityType === 'global' ? 'global' : 'collection')]
    return typeof sibling?.value === 'string' ? sibling.value : ''
  })

  const catalogue = (config.admin?.custom?.payloadRbac as
    | { entityFields?: Record<string, EntityFieldInfo[]> }
    | undefined)?.entityFields

  const fields = React.useMemo(
    () => (entitySlug ? (catalogue?.[`${entityType}:${entitySlug}`] ?? []) : []),
    [catalogue, entitySlug, entityType],
  )

  const current: FieldAccessMap = value && typeof value === 'object' ? value : {}
  const overrides = Object.keys(current).length

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      return fields
    }
    return fields.filter(
      (entry) =>
        entry.path.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle),
    )
  }, [fields, query])

  const set = (fieldPath: string, level: FieldAccessLevel | null) => {
    const next = { ...current }
    if (level === null) {
      delete next[fieldPath]
    } else {
      next[fieldPath] = level
    }
    setValue(Object.keys(next).length ? next : null)
  }

  if (!entitySlug) {
    return (
      <div className="field-type payload-rbac-field-access">
        <FieldLabel label={field?.label} path={path} />
        <p className="payload-rbac-field-access__empty">Pilih entitasnya lebih dulu.</p>
      </div>
    )
  }

  if (!fields.length) {
    return (
      <div className="field-type payload-rbac-field-access">
        <FieldLabel label={field?.label} path={path} />
        <p className="payload-rbac-field-access__empty">
          Entitas ini tidak punya field yang bisa diatur.
        </p>
      </div>
    )
  }

  return (
    <div className="field-type payload-rbac-field-access">
      <FieldLabel label={field?.label} path={path} />

      <DrawerToggler className="payload-rbac-field-access__toggler" slug={drawerSlug}>
        {overrides === 0
          ? 'Semua field mengikuti izin di atas — atur pengecualian'
          : `${overrides} field diatur khusus — ubah`}
      </DrawerToggler>

      {overrides > 0 ? (
        <ul className="payload-rbac-field-access__summary">
          {Object.entries(current).map(([fieldPath, level]) => (
            <li key={fieldPath}>
              <code>{fieldPath}</code> — {SUMMARY[level] ?? level}
            </li>
          ))}
        </ul>
      ) : null}

      <Drawer slug={drawerSlug} title={`Akses field — ${entitySlug}`}>
        <p className="payload-rbac-field-access__intro">
          Field yang dibiarkan <strong>Ikuti izin</strong> memakai aturan dari baris
          collection ini. Atur hanya yang perlu dibedakan.
        </p>

        <input
          aria-label="Cari field"
          className="payload-rbac-field-access__search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cari field…"
          type="text"
          value={query}
        />

        <div className="payload-rbac-field-access__list">
          {visible.map((entry) => {
            const level = current[entry.path] ?? null
            return (
              <div className="payload-rbac-field-access__row" key={entry.path}>
                <div className="payload-rbac-field-access__meta">
                  <span className="payload-rbac-field-access__name">{entry.label}</span>
                  <code className="payload-rbac-field-access__path">
                    {entry.path} · {entry.type}
                  </code>
                </div>
                <div className="payload-rbac-field-access__options">
                  <button
                    aria-pressed={level === null}
                    className={[
                      'payload-rbac-field-access__option',
                      level === null && 'payload-rbac-field-access__option--active',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => set(entry.path, null)}
                    title="Memakai aturan dari baris collection ini"
                    type="button"
                  >
                    Ikuti izin
                  </button>
                  {LEVELS.map((option) => (
                    <button
                      aria-pressed={level === option.value}
                      className={[
                        'payload-rbac-field-access__option',
                        level === option.value && 'payload-rbac-field-access__option--active',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      key={option.value}
                      onClick={() => set(entry.path, option.value)}
                      title={option.hint}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {visible.length === 0 ? (
            <p className="payload-rbac-field-access__empty">Tidak ada field yang cocok.</p>
          ) : null}
        </div>
      </Drawer>
    </div>
  )
}

export default FieldAccessControl
