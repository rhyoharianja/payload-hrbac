'use client'

import { useRowLabel } from '@payloadcms/ui'
import React from 'react'

type Row = {
  collection?: string
  create?: boolean
  delete?: boolean
  fieldPolicy?: string
  read?: boolean
  readVersions?: boolean
  update?: boolean
}

/**
 * Tanpa ini setiap baris hanya tertulis "Izin Collection 01", sehingga admin
 * harus membuka satu per satu untuk tahu izin apa yang sudah diberikan.
 */
export const CollectionPermissionRowLabel: React.FC = () => {
  const { data, rowNumber } = useRowLabel<Row>()

  if (!data?.collection) {
    return <span>Izin {String((rowNumber ?? 0) + 1).padStart(2, '0')} — belum dipilih</span>
  }

  const actions = [
    data.create && 'buat',
    data.read && 'baca',
    data.update && 'ubah',
    data.delete && 'hapus',
    data.readVersions && 'draft',
  ].filter(Boolean)

  // Kebijakan allowlist mengubah arti seluruh baris, jadi harus terlihat tanpa
  // membuka barisnya.
  const locked = data.fieldPolicy === 'allowlist' ? ' · field dikunci' : ''

  return (
    <span>
      {data.collection} — {actions.length ? actions.join(', ') : 'tanpa izin'}
      {locked}
    </span>
  )
}

export default CollectionPermissionRowLabel
