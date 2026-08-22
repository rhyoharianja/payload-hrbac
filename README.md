# payload-rbac — Dynamic Nested RBAC untuk Payload CMS

[![Version](https://img.shields.io/badge/Version-1.0.0-1F4C8C?style=for-the-badge)](https://github.com/rhyoharianja/payload-hrbac)
[![Payload CMS](https://img.shields.io/badge/Payload_CMS-3.88-000000?style=for-the-badge&logo=payloadcms&logoColor=white)](https://payloadcms.com)
[![Next.js](https://img.shields.io/badge/Next.js-15_%7C%2016-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Tests](https://img.shields.io/badge/Tests-62_passing-3FB950?style=for-the-badge&logo=vitest&logoColor=white)](#pengembangan)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.9-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9_%7C%2010_%7C%2011-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io/)
[![SWC](https://img.shields.io/badge/SWC-bundler-FFCF00?style=flat-square&logo=swc&logoColor=black)](https://swc.rs/)
[![Vitest](https://img.shields.io/badge/Vitest-4-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![ESLint](https://img.shields.io/badge/ESLint-9-4B32C3?style=flat-square&logo=eslint&logoColor=white)](https://eslint.org/)

[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-supported-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-supported-47A248?style=flat-square&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![SQLite](https://img.shields.io/badge/SQLite-supported-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://www.sqlite.org/)

Plugin RBAC yang dikonfigurasi dari panel admin, bukan dari kode. Menambah peran
atau menggeser hak akses tidak butuh deploy.

- **Dynamic** — daftar collection, global, dan **field** yang bisa diatur ditemukan
  sendiri dari config saat boot. Tidak ada registry yang harus dirawat manual;
  menambah collection baru langsung memunculkan pilihan izinnya di admin.
- **Nested** dalam dua arti sekaligus:
  - peran bisa **mewarisi** peran lain, berlapis;
  - izin bisa turun sampai ke **field di dalam** group, array, blocks, dan tab.

Plugin hanya **mempersempit** akses. Access control milik aplikasi tetap dijalankan
dan hasilnya diiriskan, jadi memasang plugin ini tidak bisa membuka data yang
sebelumnya tertutup.

## Pemasangan

```ts
import { payloadRbac } from 'payload-rbac'

export default buildConfig({
  admin: { user: 'users' },
  collections: [Users, Pages, Media],
  plugins: [payloadRbac()],
})
```

Itu saja. Plugin akan:

1. menambah collection `roles`;
2. menambah field relasi `roles` pada collection auth (`admin.user`);
3. memasang access CRUD pada semua collection & global yang ditemukan;
4. memasang access pada setiap field di dalamnya;
5. memasang `access.admin` dari centang "boleh membuka panel /admin".

### Langkah kedua yang wajib: `bootstrapRoles`

Instalasi baru masuk **mode bootstrap**: selama collection `roles` masih kosong,
pengguna yang login diperlakukan sebagai super admin, supaya tidak ada yang
terkunci sebelum peran pertama dibuat.

Mode itu mati begitu peran **pertama** dibuat — dan pengguna lama belum ditautkan
ke peran mana pun, jadi saat itu juga mereka kehilangan akses. Jalankan ini sekali
setelah memasang plugin, **sebelum** membuat peran lewat GUI:

```ts
import { bootstrapRoles } from 'payload-rbac'

await bootstrapRoles(payload, {
  assignSuperAdminTo: ['admin@example.com'],
  roles: [
    { name: 'Super Admin', isSuperAdmin: true, canAccessAdmin: true, slug: 'super-admin' },
    {
      name: 'Viewer',
      canAccessAdmin: true,
      collectionPermissions: [{ collection: 'pages', read: true }],
      slug: 'viewer',
    },
    {
      // Pewarisan: cukup tulis tambahannya.
      name: 'Editor',
      collectionPermissions: [{ collection: 'pages', create: true, update: true }],
      parent: 'viewer',
      slug: 'editor',
    },
  ],
})
```

Idempoten — peran dicocokkan lewat `slug` dan yang sudah ada tidak ditimpa.
`assignSuperAdminTo` bawaannya `'auto'`: hanya menetapkan bila **tepat satu**
pengguna belum punya peran. Kalau lebih dari satu, skrip tidak menebak siapa yang
layak, ia hanya memberi tahu.

## Cara kerja izin

### Beberapa peran = gabungan (OR)

Punya dua peran berarti punya gabungan izin keduanya; peran paling longgar menang.
Tidak ada mekanisme "deny menang" antar peran — mencabut satu centang di satu peran
tidak pernah bisa menambah akses, dan itu yang membuat hasilnya bisa ditebak.

### Pewarisan ≠ memegang dua peran

Peran turunan **adalah** induknya plus penyesuaiannya. Karena itu turunan boleh
**mempersempit** — menutup field yang induknya biarkan terbuka. Sementara dua peran
yang ditugaskan terpisah tidak pernah bisa saling memangkas.

```
Reader          posts: read
  └─ Editor     posts: update           → efektif: read + update
       └─ Lead  posts: delete           → efektif: read + update + delete
```

### Izin field

Ini menjawab satu pertanyaan saja, per field:

> **Pemegang peran ini boleh apa pada field tersebut?**

Jawabannya satu pilihan, bukan tiga centang:

| Pilihan | Yang dilihat pengguna |
|---|---|
| **Boleh ubah** | Field tampil normal dan bisa diisi. |
| **Hanya baca** | Field **tetap tampil** beserta nilainya, tapi tidak bisa diisi atau diubah. |
| **Tersembunyi** | Field **tidak muncul sama sekali**, dan nilainya tidak ikut terkirim ke browser. |

Ketiganya bukan istilah buatan plugin ini — persis perilaku Payload sendiri.
`RenderFields` mengembalikan `null` bila tidak ada izin baca, dan memaksa
`readOnly` bila tidak ada izin operasinya. Yang plugin ini lakukan hanyalah
menerjemahkan satu pilihan Anda ke tiga izin yang dimengerti Payload:

| Pilihan | `read` | `create` | `update` |
|---|---|---|---|
| Boleh ubah | ✓ | ✓ | ✓ |
| Hanya baca | ✓ | — | — |
| Tersembunyi | — | — | — |

Penegakannya berlaku di **semua jalur**, bukan hanya tampilan: lewat REST/GraphQL
pun, nilai field "tersembunyi" tidak ikut terkirim, dan perubahan pada field
"hanya baca" diabaikan diam-diam sementara field lain di dokumen yang sama tetap
tersimpan.

#### Di mana mengaturnya

**Semuanya di satu tempat: di dalam baris collection/global-nya sendiri.**

Tab *Collection & Global* → satu baris per entitas yang boleh disentuh peran ini.
Di dalam baris itu ada tiga hal:

1. **Centang CRUD** — Buat / Baca / Ubah / Hapus.
2. **Field yang tidak didaftarkan** — satu dropdown:
   - *Boleh diubah* (bawaan) — hanya field yang Anda atur khusus yang dibatasi
   - *Tertutup* — hanya field yang Anda atur khusus yang boleh
3. **Akses per Field** — tombol yang membuka panel berisi **field milik
   collection itu saja**, masing-masing dengan empat pilihan:

   > `Ikuti izin` · `Boleh ubah` · `Hanya baca` · `Tersembunyi`

   `Ikuti izin` adalah bawaan dan tidak menyimpan apa pun — field itu memakai
   aturan dari poin 1 dan 2. Jadi baris tanpa pengecualian tetap kosong.

Tidak ada tab terpisah dan tidak ada dropdown berisi seluruh field dari seluruh
collection. Daftar yang muncul mengikuti entitas yang dipilih di baris yang sama;
mengganti collection langsung mengganti daftarnya.

Panelnya punya kotak pencarian, dan ringkasan pengecualian tampil langsung di
baris tanpa perlu membukanya.

**Catatan teknis:** nilainya disimpan sebagai `json` (`path field → tingkat
akses`), bukan sebagai baris array dengan `select`. Selain karena daftar
pilihannya harus difilter per baris — yang tidak bisa dilakukan `select` Payload
— sebuah `select` berisi seluruh field dari seluruh collection akan menjadi enum
Postgres bernilai ribuan yang ikut berubah setiap kali ada field ditambah.

#### Contoh

**"Editor boleh mengubah artikel, tapi kolom catatan internal hanya boleh dibaca."**

1. Tab *Collection & Global* → tambah baris `articles`, centang Baca + Ubah.
2. Di baris yang sama → **Akses per Field** → cari `internalNotes` → pilih
   **Hanya baca**.

Hasil: editor bisa mengubah judul, isi, dan seluruh field lain; kolom catatan
internal tetap terlihat tapi tidak bisa diketik.

**"Kontributor hanya boleh mengubah judul artikel, tidak boleh yang lain."**

1. Tab *Collection & Global* → baris `articles`, centang Baca + Ubah, lalu ubah
   "Field yang tidak didaftarkan" menjadi **Tertutup**.
2. Di baris yang sama → **Akses per Field** → `title` → **Boleh ubah**.

Hasil: hanya judul yang bisa diubah; field lain tampil read-only.

#### Field bersarang

Bentuk path field:

```
title                  field biasa
hero.heading           group / tab bernama
links.label            array (izin berlaku untuk seluruh baris, bukan baris tertentu)
layout.cta.heading     blocks: <namaField>.<slugBlock>.<field>
```

Wadah tanpa nama (`row`, `collapsible`, tab tanpa nama) transparan — anaknya
memakai prefix induk bernama terdekat.

Pada mode *Tertutup*, wadah induk ikut terbuka bila anaknya terdaftar:
mendaftarkan `hero.heading` sudah cukup, tidak perlu ikut mendaftarkan `hero`.
Kalau tidak, Payload membuang seluruh group sebelum sampai ke anaknya.

#### Saat peran digabung

Aturan OR tetap berlaku: **satu field tertutup hanya bila SEMUA peran yang
dimiliki user menutupnya.** Peran yang tidak berpendapat soal field itu dianggap
mengizinkan. Untuk pewarisan berlaku sebaliknya — peran turunan boleh
mempersempit, karena ia adalah induknya plus penyesuaian.

**Batasan yang disengaja:** izin field hanya berlaku bagi pengguna collection auth
yang dikelola. Untuk pembaca publik plugin tidak ikut campur, karena yang diatur
admin adalah "siapa di antara staf yang boleh menyentuh field ini" — menyembunyikan
field dari API publik adalah urusan access control collection.

## Opsi

| Opsi | Bawaan | Keterangan |
|---|---|---|
| `rolesSlug` | `roles` | Slug collection peran. |
| `authCollection` | `admin.user` / `users` | Collection yang memiliki peran. |
| `userRolesField` | `roles` | Nama field relasi peran. |
| `collections` / `globals` | semua | Batasi entitas yang dikelola. |
| `excludeCollections` / `excludeGlobals` | `[]` | Kebalikannya. |
| `fieldPermissionEntities` | semua | Batasi entitas yang muncul di dropdown izin field. Berguna pada proyek besar. |
| `excludeFieldPaths` | `[]` | Path field yang tidak boleh disentuh RBAC, mis. `collection:users:email`. |
| `enforceCollectionAccess` | `true` | Pasang access CRUD. |
| `enforceFieldAccess` | `true` | Pasang access field. |
| `enforceAdminAccess` | `true` | Pasang `access.admin`. |
| `cache` | in-memory | Ganti untuk deployment multi-instance. |
| `cacheTTLSeconds` | `60` | Umur cache matriks izin. |
| `bootstrapSuperAdmin` | `true` | Mode anti-lockout saat `roles` kosong. |
| `adminGroup` | `System` | Grup sidebar collection `roles`. |
| `entityLabels` | `{}` | Label ramah untuk slug tertentu. |
| `disabled` | `false` | Matikan penegakan, collection `roles` tetap ada (skema tetap konsisten untuk migrasi). |

### Cache multi-instance

Bawaannya in-memory, cukup untuk satu proses. Untuk beberapa instance, pasang
adapter sendiri supaya perubahan peran langsung terasa di semua node:

```ts
import type { PayloadRbacCache } from 'payload-rbac'

const redisCache: PayloadRbacCache = {
  clear: async (prefix) => {
    /* SCAN + DEL, jangan KEYS — blocking di production */
  },
  get: (key) => redis.get(key),
  set: async (key, value, ttl) => {
    await redis.set(key, value, 'EX', ttl)
  },
}

payloadRbac({ cache: redisCache })
```

## Helper di luar access control

Untuk route handler, hook, atau komponen server:

```ts
import { createPayloadRbacHelpers } from 'payload-rbac'

const rbac = createPayloadRbacHelpers({ authCollection: 'users' })

await rbac.can(req, 'pages', 'update')
await rbac.canField(req, 'collection', 'pages', 'hero.heading', 'update')
await rbac.isSuperAdmin(req)
await rbac.hasRole(req, 'editor')

// Siap dipakai sebagai `access` collection:
export const Secrets = { access: { read: rbac.superAdminOnly } }
```

Opsi yang dioper harus sama dengan yang dipakai saat memasang plugin.

## Pengaman anti-lockout

1. Peran `isSuperAdmin` mengabaikan seluruh centang, dan peran super admin
   **terakhir** tidak bisa dihapus.
2. Peran `isSystem` tidak bisa dihapus.
3. Peran yang masih menjadi induk peran lain, atau masih dipakai pengguna, tidak
   bisa dihapus.
4. Rantai pewarisan melingkar ditolak saat disimpan, dan tetap aman dibaca kalau
   sudah terlanjur ada.
5. Field `roles` pada pengguna hanya bisa diubah super admin — tanpa ini siapa pun
   yang boleh mengubah pengguna bisa menaikkan haknya sendiri.
6. Collection `roles` hanya bisa ditulis super admin.

## Catatan Postgres

Setiap field `select` menjadi tipe **enum** di Postgres, termasuk dropdown izin
field. Konsekuensinya:

- Menambah/menghapus field di aplikasi mengubah enum, jadi ikut muncul di
  migrasi. Ini wajar — daftar izin memang harus mengikuti skema.
- Pada proyek besar dropdown-nya bisa berisi ribuan opsi. Pakai
  `fieldPermissionEntities` untuk membatasinya ke entitas yang benar-benar butuh
  kontrol per-field.
- Entitas yang **tidak ada** tidak pernah dibuatkan field-nya: proyek tanpa global
  tidak akan punya `globalPermissions`. Enum kosong tidak terlihat oleh pembanding
  skema Payload dan akan gagal dibuat ulang di setiap boot, jadi ini disengaja.

## Pengembangan

```bash
pnpm install
pnpm test        # 40 unit + 22 integrasi (SQLite in-memory)
pnpm build
pnpm dev         # test bed di dev/
```

## Dukungan

Kalau paket ini menghemat waktu Anda, kontribusi kecil sangat dihargai — meski tidak
pernah diharapkan. Dananya dipakai untuk menjaga paket ini tetap mengikuti rilis Payload.

<a href="https://paypal.me/sgkharianja" target="_blank">
  <img src="https://img.shields.io/badge/Donate-PayPal-0070BA?style=for-the-badge&logo=paypal&logoColor=white" alt="Donate with PayPal" height="40"/>
</a>
&nbsp;&nbsp;
<a href="https://saweria.co/rhioharianja" target="_blank">
  <img src="https://img.shields.io/badge/Saweria-Donate-F97316?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Donate via Saweria" height="40"/>
</a>

Laporan bug dan pull request sama berharganya, dan gratis:
[buka issue](https://github.com/rhyoharianja/payload-hrbac/issues).

## Lisensi

MIT © Suryo Galih Kencana Harianja. Lihat [LICENSE](LICENSE).
