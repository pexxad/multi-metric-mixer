import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely'
import { Pool } from 'pg'

export type DatabaseDriver =
  | { kind: 'sqlite'; filename: string }
  | { kind: 'postgres'; connectionString: string; caCertificate: string; maxConnections?: number }

export async function openQuery(driver: DatabaseDriver): Promise<Kysely<Record<string, Record<string, unknown>>>> {
  if (driver.kind === 'sqlite') {
    if (driver.filename !== ':memory:') mkdirSync(dirname(driver.filename), { recursive: true, mode: 0o700 })
    const sqlite = new BetterSqlite3(driver.filename)
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('busy_timeout = 5000')
    return new Kysely({ dialect: new SqliteDialect({ database: sqlite }) })
  }
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: driver.connectionString,
        max: driver.maxConnections ?? 10,
        ssl: { rejectUnauthorized: true, ca: driver.caCertificate },
      }),
    }),
  })
}
