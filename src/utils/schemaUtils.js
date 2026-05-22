/**
 * Extract alert names from a per-alert schema.
 * Schema shape: { properties: { alertName: { type: "array", items: { properties: {...} } } } }
 */
export function schemaAlertNames(schema) {
  if (!schema?.properties) return []
  return Object.keys(schema.properties).filter(k => !k.startsWith('$'))
}

export function getCommonVars(schema) {
  const vars = schema?.['x-common-vars']
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

export function setCommonVars(schema, vars) {
  if (!vars || vars.length === 0) {
    const { 'x-common-vars': _, ...rest } = schema || {}
    return rest
  }
  const properties = {}
  const required = []
  for (const v of vars) {
    properties[v.name] = varToSchemaProp(v)
    if (v.required) required.push(v.name)
  }
  return {
    ...schema,
    'x-common-vars': {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {})
    }
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
