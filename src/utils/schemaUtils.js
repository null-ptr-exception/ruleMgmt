export function schemaToVars(schema) {
  if (!schema?.properties?.instances?.items?.properties) return []
  const items = schema.properties.instances.items
  const props = items.properties
  const required = new Set(items.required || [])
  return Object.entries(props).map(([name, prop]) => {
    const v = { name, type: prop.type || 'string', description: prop.description || '', required: required.has(name) }
    if (prop.default !== undefined) v.default = prop.default
    if (prop.enum) v.enum = prop.enum
    return v
  })
}

export function varsToSchema(vars) {
  const properties = {}
  const required = []
  for (const v of vars) {
    const prop = { type: v.type || 'string' }
    if (v.description) prop.description = v.description
    if (v.default !== undefined) prop.default = v.default
    if (v.enum) prop.enum = v.enum
    properties[v.name] = prop
    if (v.required) required.push(v.name)
  }
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      instances: {
        type: 'array',
        items: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {})
        }
      }
    }
  }
}
