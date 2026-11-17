import { readFile } from 'node:fs/promises'
import { closeDatabase, rows, transaction } from './db.js'
import { logError } from './safe-logger.js'

const productPermissions = [
  'products.view',
  'products.create',
  'products.edit',
  'products.delete',
]

async function migrateProducts(): Promise<void> {
  const migrationSql = await readFile(
    new URL('../migrations/20261113_products_and_images.sql', import.meta.url),
    'utf8',
  )
  const cleanupMigrationSql = await readFile(
    new URL('../migrations/20261116_persist_product_image_cleanup.sql', import.meta.url),
    'utf8',
  )
  const saleItemsMigrationSql = await readFile(
    new URL('../migrations/20261116_sale_items_product_id.sql', import.meta.url),
    'utf8',
  )
  const productUnitsMigrationSql = await readFile(
    new URL('../migrations/20261117_product_units.sql', import.meta.url),
    'utf8',
  )

  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [2026111301])
    const existingColumns = await rows<{
      table_name: string
      column_name: string
      data_type: string
    }>(
      `SELECT table_name,column_name,data_type
       FROM information_schema.columns
       WHERE table_schema=current_schema()
         AND (table_name,column_name) IN (
           ('businesses','id'),
           ('users','id'),
           ('business_user','business_id'),
           ('business_user','user_id'),
           ('business_user','role'),
           ('business_user','permissions')
         )`,
      [],
      client,
    )
    const columnTypes = new Map(
      existingColumns.map((column) => [`${column.table_name}.${column.column_name}`, column.data_type]),
    )
    const requiredColumns = [
      'businesses.id',
      'users.id',
      'business_user.business_id',
      'business_user.user_id',
      'business_user.role',
      'business_user.permissions',
    ]
    const missingColumns = requiredColumns.filter((column) => !columnTypes.has(column))
    if (missingColumns.length) {
      throw new Error(`Product migration prerequisites are missing: ${missingColumns.join(', ')}.`)
    }

    for (const column of ['businesses.id', 'users.id', 'business_user.business_id', 'business_user.user_id']) {
      if (columnTypes.get(column) !== 'bigint') {
        throw new Error(`Product migration requires ${column} to be bigint.`)
      }
    }
    if (!['json', 'jsonb'].includes(columnTypes.get('business_user.permissions') || '')) {
      throw new Error('Product migration requires business_user.permissions to be json or jsonb.')
    }

    await client.query(migrationSql)
    await client.query(cleanupMigrationSql)
    await client.query(saleItemsMigrationSql)
    await client.query(productUnitsMigrationSql)

    const employees = await rows<{
      business_id: number
      user_id: number
      permissions: unknown
    }>(
      "SELECT business_id,user_id,permissions FROM business_user WHERE role='employee'",
      [],
      client,
    )

    for (const employee of employees) {
      let permissions: unknown = employee.permissions
      if (typeof permissions === 'string') permissions = JSON.parse(permissions)
      if (permissions === null) permissions = []
      if (!Array.isArray(permissions) || !permissions.every((permission) => typeof permission === 'string')) {
        throw new Error(`Employee ${employee.user_id} has invalid stored permissions.`)
      }

      const updated = [...new Set([...permissions, ...productPermissions])]
      if (updated.length !== permissions.length) {
        await client.query(
          'UPDATE business_user SET permissions=$1 WHERE business_id=$2 AND user_id=$3',
          [JSON.stringify(updated), employee.business_id, employee.user_id],
        )
      }
    }
  })
}

try {
  await migrateProducts()
  console.log('Product tables and employee permissions are ready.')
} catch (error) {
  logError('products.migration', error)
  process.exitCode = 1
} finally {
  await closeDatabase()
}
