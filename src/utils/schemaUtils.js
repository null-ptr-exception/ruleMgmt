/**
 * A schema `properties` key that names an alert group — not a `$`-prefixed
 * meta key (`$schema` and friends) and not `_common` (chart-level variables,
 * which live alongside the groups once the schema is a standard JSON Schema).
 * The one place this rule lives; callers iterating `schema.properties` use it
 * instead of spelling out `!k.startsWith('$')`.
 */
export function isAlertGroup(key) {
  return typeof key === 'string' && key !== '_common' && !key.startsWith('$')
}

/**
 * A chart's common (chart-level) variable definitions — `{ properties, required }`
 * — from whichever representation the schema carries: the standard
 * `properties._common` the generator now emits (Helm validates it, being a real
 * property), or the legacy `x-common-vars` extension an un-migrated chart still
 * has. Readers go through this; only the generator decides which to write.
 */
export function getCommonSchema(schema) {
  return schema?.properties?._common || schema?.['x-common-vars'] || null
}

/**
 * Extract alert names from a per-alert schema.
 * Schema shape: { properties: { alertName: { type: "array", items: { properties: {...} } } } }
 */
export function schemaAlertNames(schema) {
  if (!schema?.properties) return []
  return Object.keys(schema.properties).filter(isAlertGroup)
}

export function getCommonVars(schema) {
  const vars = getCommonSchema(schema)
  if (!vars || !vars.properties) return []
  const required = new Set(vars.required || [])
  return Object.entries(vars.properties).map(([name, prop]) => {
    const uiType = prop.enum ? 'enum' : (prop.type || 'string')
    const v = { name, type: uiType, description: prop.description || '', required: required.has(name) }
    if (prop.default !== undefined) v.default = prop.default
    if (prop.enum) v.enum = prop.enum
    return v
  })
}

/**
 * Writes common variables as the standard `properties._common`, and drops the
 * legacy `x-common-vars` if the schema still had one — the output is a plain
 * JSON Schema with no custom extension for the common block.
 */
export function setCommonVars(schema, vars) {
  const { 'x-common-vars': _legacy, ...base } = schema || {}
  const { _common: _drop, ...groupProps } = base.properties || {}

  if (!vars || vars.length === 0) {
    return { ...base, properties: groupProps }
  }

  const properties = {}
  const required = []
  for (const v of vars) {
    properties[v.name] = varToSchemaProp(v)
    if (v.required) required.push(v.name)
  }
  return {
    ...base,
    properties: {
      _common: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
      ...groupProps,
    },
  }
}

/**
 * Extract vars array for a specific alert name from schema.
 */
export function schemaToVars(schema, alertName) {
  const alertDef = schema?.properties?.[alertName]
  if (!alertDef?.items?.properties) return []

  const common = getCommonVars(schema)
  const commonNames = new Set(common.map(v => v.name))

  const items = alertDef.items
  const props = items.properties
  const required = new Set(items.required || [])
  const groupVars = Object.entries(props)
    .filter(([name]) => !commonNames.has(name))
    .map(([name, prop]) => {
      const uiType = prop.enum ? 'enum' : (prop.type || 'string')
      const v = { name, type: uiType, description: prop.description || '', required: required.has(name) }
      if (prop.default !== undefined) v.default = prop.default
      if (prop.enum) v.enum = prop.enum
      return v
    })

  return [...common, ...groupVars]
}

/**
 * Build a full schema from a map of { alertName: vars[] }.
 */
function varToSchemaProp(v) {
  const isEnum = v.type === 'enum'
  const prop = { type: isEnum ? 'string' : (v.type || 'string') }
  if (v.description) prop.description = v.description
  if (v.default !== undefined) prop.default = v.default
  if (isEnum) prop.enum = v.enum || []
  return prop
}

export function varsMapToSchema(varsMap) {
  const properties = {}
  for (const [alertName, vars] of Object.entries(varsMap)) {
    const itemProps = {}
    const required = []
    for (const v of vars) {
      itemProps[v.name] = varToSchemaProp(v)
      if (v.required) required.push(v.name)
    }
    properties[alertName] = {
      type: 'array',
      items: {
        type: 'object',
        properties: itemProps,
        ...(required.length > 0 ? { required } : {})
      }
    }
  }
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    properties
  }
}

/**
 * Update a single alert's vars in an existing schema, returning new schema.
 */
export function updateSchemaAlert(schema, alertName, vars) {
  const itemProps = {}
  const required = []
  for (const v of vars) {
    itemProps[v.name] = varToSchemaProp(v)
    if (v.required) required.push(v.name)
  }
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [alertName]: {
        type: 'array',
        items: {
          type: 'object',
          properties: itemProps,
          ...(required.length > 0 ? { required } : {})
        }
      }
    }
  }
}
