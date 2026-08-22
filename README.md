# payload-rbac — Dynamic Nested RBAC for Payload CMS

[![Version](https://img.shields.io/badge/Version-1.0.0-1F4C8C?style=for-the-badge)](https://github.com/rhyoharianja/payload-hrbac)
[![Payload CMS](https://img.shields.io/badge/Payload_CMS-3.88-000000?style=for-the-badge&logo=payloadcms&logoColor=white)](https://payloadcms.com)
[![Next.js](https://img.shields.io/badge/Next.js-15_%7C%2016-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Tests](https://img.shields.io/badge/Tests-62_passing-3FB950?style=for-the-badge&logo=vitest&logoColor=white)](#development)
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

An RBAC plugin configured from the admin panel rather than from code. Adding a role
or adjusting a permission requires no deployment.

- **Dynamic** — the list of manageable collections, globals, and **fields** is
  discovered from the config at boot. There is no registry to maintain by hand;
  adding a new collection immediately surfaces its permissions in the admin panel.
- **Nested** in two senses at once:
  - a role may **inherit** from another role, to any depth;
  - a permission may reach down to **fields inside** groups, arrays, blocks, and tabs.

The plugin only ever **narrows** access. Your application's own access control still
runs and the two results are intersected, so installing this plugin cannot open up
data that was previously closed.

## Installation

```ts
import { payloadRbac } from 'payload-rbac'

export default buildConfig({
  admin: { user: 'users' },
  collections: [Users, Pages, Media],
  plugins: [payloadRbac()],
})
```

That is all. The plugin will:

1. add a `roles` collection;
2. add a `roles` relationship field to the auth collection (`admin.user`);
3. attach CRUD access control to every collection and global it discovers;
4. attach access control to each field within them;
5. derive `access.admin` from the "may open the /admin panel" checkbox.

### The mandatory second step: `bootstrapRoles`

A fresh installation starts in **bootstrap mode**: for as long as the `roles`
collection is empty, any authenticated user is treated as a super admin, so that
nobody is locked out before the first role exists.

That mode ends the moment the **first** role is created — and since existing users
are not yet linked to any role, they lose access at exactly that point. Run the
following once after installing the plugin, **before** creating roles through the
GUI:

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
      // Inheritance: declare only the additions.
      name: 'Editor',
      collectionPermissions: [{ collection: 'pages', create: true, update: true }],
      parent: 'viewer',
      slug: 'editor',
    },
  ],
})
```

The call is idempotent — roles are matched by `slug`, and existing ones are never
overwritten. `assignSuperAdminTo` defaults to `'auto'`, which assigns the role only
when **exactly one** user is without one. If more than one qualifies, the script
does not guess who deserves it; it simply reports the situation.

## How permissions resolve

### Multiple roles are unioned (OR)

Holding two roles means holding the union of their permissions; the most permissive
role wins. There is no "deny wins" mechanism between roles — clearing a checkbox on
one role can never grant access, and that is precisely what makes the outcome
predictable.

### Inheritance is not the same as holding two roles

A child role **is** its parent plus its own adjustments. It may therefore **narrow**
the parent — closing a field the parent left open. Two separately assigned roles, by
contrast, can never trim one another.

```
Reader          posts: read
  └─ Editor     posts: update           → effective: read + update
       └─ Lead  posts: delete           → effective: read + update + delete
```

### Field permissions

These answer a single question, per field:

> **What may the holder of this role do with that field?**

The answer is one choice, not three checkboxes:

| Choice | What the user sees |
|---|---|
| **Editable** (`Boleh ubah`) | The field renders normally and can be filled in. |
| **Read-only** (`Hanya baca`) | The field **still renders**, value included, but cannot be filled in or changed. |
| **Hidden** (`Tersembunyi`) | The field **does not render at all**, and its value is never sent to the browser. |

None of the three is an invention of this plugin — they are Payload's own behaviour.
`RenderFields` returns `null` when there is no read permission, and forces `readOnly`
when the operation is not permitted. All this plugin does is translate your single
choice into the three permissions Payload understands:

| Choice | `read` | `create` | `update` |
|---|---|---|---|
| Editable | ✓ | ✓ | ✓ |
| Read-only | ✓ | — | — |
| Hidden | — | — | — |

Enforcement applies across **every route**, not merely the UI: over REST and GraphQL
alike, the value of a "hidden" field is not transmitted, and writes to a "read-only"
field are silently discarded while the remaining fields of the same document are
still saved.

#### Where it is configured

**Everything sits in one place: inside the row for the collection or global itself.**

The *Collection & Global* tab holds one row per entity this role may touch. Each row
contains three things:

1. **CRUD checkboxes** — Create / Read / Update / Delete.
2. **Unlisted fields** (`Field yang tidak didaftarkan`) — a single dropdown:
   - *Editable* (`Boleh diubah`, the default) — only the fields you configure
     explicitly are restricted;
   - *Closed* (`Tertutup`) — only the fields you configure explicitly are permitted.
3. **Per-field access** (`Akses per Field`) — a button that opens a panel listing
   **only the fields belonging to that collection**, each with four choices:

   > `Ikuti izin` (inherit) · `Boleh ubah` (editable) · `Hanya baca` (read-only) ·
   > `Tersembunyi` (hidden)

   `Ikuti izin` is the default and stores nothing — such a field simply follows the
   rules from points 1 and 2. A row with no exceptions therefore stays empty.

There is no separate tab, and no dropdown containing every field of every
collection. The list shown follows the entity selected in the same row; changing the
collection changes the list immediately.

The panel provides a search box, and a summary of the configured exceptions appears
on the row itself without having to open it.

**Implementation note:** the value is stored as `json` (`field path → access level`)
rather than as array rows with a `select`. Beyond the fact that the option list has
to be filtered per row — which a Payload `select` cannot do — a `select` holding
every field of every collection would become a Postgres enum with thousands of
members that changes every time a field is added.

#### Examples

**"Editors may edit articles, but the internal notes column is read-only."**

1. *Collection & Global* tab → add a row for `articles`, tick Read + Update.
2. In the same row → **Akses per Field** → search for `internalNotes` → choose
   **Hanya baca** (read-only).

Result: the editor can change the title, the body, and every other field; the
internal notes column remains visible but cannot be typed into.

**"Contributors may edit the article title and nothing else."**

1. *Collection & Global* tab → row for `articles`, tick Read + Update, then set
   `Field yang tidak didaftarkan` to **Tertutup** (closed).
2. In the same row → **Akses per Field** → `title` → **Boleh ubah** (editable).

Result: only the title is editable; every other field renders read-only.

#### Nested fields

Field paths take the following shape:

```
title                  a plain field
hero.heading           a named group or tab
links.label            an array (the permission covers every row, not a single one)
layout.cta.heading     blocks: <fieldName>.<blockSlug>.<field>
```

Unnamed containers (`row`, `collapsible`, unnamed tabs) are transparent — their
children take the prefix of the nearest named ancestor.

In *Tertutup* (closed) mode, a parent container is opened automatically when one of
its children is listed: listing `hero.heading` is sufficient, and `hero` need not be
listed as well. Without that, Payload would discard the entire group before ever
reaching its children.

#### When roles are combined

The OR rule continues to apply: **a field is closed only if EVERY role the user
holds closes it.** A role that expresses no opinion about a field is taken to permit
it. For inheritance the reverse holds — a child role may narrow, because it is its
parent plus adjustments.

**A deliberate limitation:** field permissions apply only to users of the managed
auth collection. The plugin does not interfere with public readers, because what the
administrator configures is "which member of staff may touch this field" — hiding a
field from a public API is a matter for collection access control.

## Options

| Option | Default | Description |
|---|---|---|
| `rolesSlug` | `roles` | Slug of the roles collection. |
| `authCollection` | `admin.user` / `users` | The collection that holds roles. |
| `userRolesField` | `roles` | Name of the roles relationship field. |
| `collections` / `globals` | all | Restrict which entities are managed. |
| `excludeCollections` / `excludeGlobals` | `[]` | The inverse. |
| `fieldPermissionEntities` | all | Restrict which entities appear in the field-permission dropdown. Useful on large projects. |
| `excludeFieldPaths` | `[]` | Field paths RBAC must not touch, e.g. `collection:users:email`. |
| `enforceCollectionAccess` | `true` | Attach CRUD access control. |
| `enforceFieldAccess` | `true` | Attach field access control. |
| `enforceAdminAccess` | `true` | Attach `access.admin`. |
| `cache` | in-memory | Replace for multi-instance deployments. |
| `cacheTTLSeconds` | `60` | Lifetime of the permission-matrix cache. |
| `bootstrapSuperAdmin` | `true` | Anti-lockout mode while `roles` is empty. |
| `adminGroup` | `System` | Sidebar group for the `roles` collection. |
| `entityLabels` | `{}` | Friendly labels for particular slugs. |
| `disabled` | `false` | Disable enforcement while keeping the `roles` collection (so the schema stays consistent for migrations). |

### Multi-instance caching

The default cache is in-memory, which is sufficient for a single process. For
several instances, supply your own adapter so that a change to a role takes effect
on every node at once:

```ts
import type { PayloadRbacCache } from 'payload-rbac'

const redisCache: PayloadRbacCache = {
  clear: async (prefix) => {
    /* SCAN + DEL, never KEYS — it blocks in production */
  },
  get: (key) => redis.get(key),
  set: async (key, value, ttl) => {
    await redis.set(key, value, 'EX', ttl)
  },
}

payloadRbac({ cache: redisCache })
```

## Helpers outside access control

For route handlers, hooks, or server components:

```ts
import { createPayloadRbacHelpers } from 'payload-rbac'

const rbac = createPayloadRbacHelpers({ authCollection: 'users' })

await rbac.can(req, 'pages', 'update')
await rbac.canField(req, 'collection', 'pages', 'hero.heading', 'update')
await rbac.isSuperAdmin(req)
await rbac.hasRole(req, 'editor')

// Ready to use as collection `access`:
export const Secrets = { access: { read: rbac.superAdminOnly } }
```

The options passed here must match those given when the plugin was installed.

## Anti-lockout safeguards

1. A role marked `isSuperAdmin` ignores every checkbox, and the **last** remaining
   super admin role cannot be deleted.
2. A role marked `isSystem` cannot be deleted.
3. A role that is still the parent of another role, or is still assigned to a user,
   cannot be deleted.
4. Circular inheritance chains are rejected on save, and remain safe to read should
   one already exist.
5. The `roles` field on a user may be changed only by a super admin — without this,
   anyone permitted to edit users could escalate their own privileges.
6. The `roles` collection is writable by super admins only.

## Postgres notes

Every `select` field becomes an **enum** type in Postgres, the field-permission
dropdown included. The consequences are:

- Adding or removing a field in the application alters the enum, so it shows up in
  migrations. This is expected — the permission list is supposed to track the
  schema.
- On a large project the dropdown may hold thousands of options. Use
  `fieldPermissionEntities` to narrow it to the entities that genuinely require
  per-field control.
- Entities that do **not** exist never have a field generated for them: a project
  without globals will have no `globalPermissions`. An empty enum is invisible to
  Payload's schema comparator and would fail to be recreated on every boot, so this
  is deliberate.

## Development

```bash
pnpm install
pnpm test        # 40 unit + 22 integration (SQLite in-memory)
pnpm build
pnpm dev         # test bed in dev/
```

## Support

If this package saved you time, a contribution is warmly appreciated — though never
expected. It goes towards keeping the package current with Payload's releases.

<a href="https://www.paypal.com/paypalme/sgkharianja" target="_blank">
  <img src="https://img.shields.io/badge/Donate-PayPal-0070BA?style=for-the-badge&logo=paypal&logoColor=white" alt="Donate with PayPal" height="40"/>
</a>
&nbsp;&nbsp;
<a href="https://saweria.co/rhioharianja" target="_blank">
  <img src="https://img.shields.io/badge/Saweria-Donate-F97316?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Donate via Saweria" height="40"/>
</a>

Bug reports and pull requests are equally valuable, and free:
[open an issue](https://github.com/rhyoharianja/payload-hrbac/issues).

## License

MIT © Suryo Galih Kencana Harianja. See [LICENSE](LICENSE).
