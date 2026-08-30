/**
 * Moving a deployment's rows from one chart to a clone of it — see issue #57.
 *
 * A breaking change is made on a copy so the original keeps working and each
 * rule owner moves when they are ready. What their rows have to become is
 * declared by whoever made the change, at the moment they made it: only they
 * know whether `warn_pct` became `warn_ratio` or simply went away.
 *
 * The declaration lives on the clone as `x-migrated-from`:
 *
 *   { chart: 'mariadb-alerts', columns: { warn_pct: 'warn_ratio' }, dropped: ['crit_pct'] }
 *
 * A column not named anywhere keeps its name.
 */

/** Rows for one alert group, moved through a declaration. */
export function migrateRows(rows, migration) {
  const renames = migration?.columns || {}
  const dropped = new Set(migration?.dropped || [])

  return (rows || []).map(row => {
    const moved = {}
    for (const [column, value] of Object.entries(row)) {
      if (dropped.has(column)) continue
      moved[renames[column] || column] = value
    }
    return moved
  })
}

/**
 * A whole deployment's values.
 * Groups the clone no longer has are left behind and reported, never guessed at.
 */
export function migrateValues(values, migration, targetSchema) {
  const groups = targetSchema?.properties || {}
  const migrated = {}
  const orphaned = []

  for (const [group, rows] of Object.entries(values || {})) {
    const targetGroup = migration?.groups?.[group] || group
    if (!(targetGroup in groups)) {
      orphaned.push(group)
      continue
    }
    migrated[targetGroup] = Array.isArray(rows) ? migrateRows(rows, migration) : rows
  }

  return { values: migrated, orphaned }
}

/**
 * Columns a row would lose, so the person moving can see it before it happens
 * rather than discover it afterwards.
 */
export function migrationLosses(values, migration, targetSchema) {
  const dropped = new Set(migration?.dropped || [])
  const losses = []

  for (const [group, rows] of Object.entries(values || {})) {
    if (!Array.isArray(rows)) continue
    const targetGroup = migration?.groups?.[group] || group
    const targetColumns = Object.keys(targetSchema?.properties?.[targetGroup]?.items?.properties || {})
    const renames = migration?.columns || {}

    const lost = new Set()
    for (const row of rows) {
      for (const column of Object.keys(row)) {
        if (dropped.has(column)) { lost.add(column); continue }
        if (!targetColumns.includes(renames[column] || column)) lost.add(column)
      }
    }
    if (lost.size) losses.push({ group, columns: [...lost].sort() })
  }

  return losses
}
