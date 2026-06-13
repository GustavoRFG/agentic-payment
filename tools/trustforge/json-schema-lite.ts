/**
 * json-schema-lite — a small, dependency-free validator for the subset of
 * JSON Schema (draft 2020-12) used by the TrustForge contracts.
 *
 * Why not AJV: AJV is installed under `seller-api` and `mcp-gateway` but not at
 * the repository root where the root `vitest` runner resolves modules. A
 * self-contained validator runs identically under root `vitest` and under
 * `npm --prefix seller-api exec -- tsx`, needs no network install, and is
 * deterministic. It intentionally supports only the keywords these schemas use.
 *
 * Supported: type, const, enum, pattern, minLength, maxLength, minimum,
 * maximum, exclusiveMinimum, exclusiveMaximum, required, properties,
 * additionalProperties (boolean | schema), items (schema), minItems, maxItems,
 * uniqueItems, format ("date-time" | "uri"), allOf, anyOf, $ref (to
 * "#/$defs/<name>" within the same document), and $defs.
 */

export type JsonSchema = Record<string, unknown>;

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported $ref (only local refs allowed): ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      throw new Error(`cannot resolve $ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (!current || typeof current !== "object") {
    throw new Error(`$ref did not resolve to a schema: ${ref}`);
  }
  return current as JsonSchema;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

function validateNode(
  root: JsonSchema,
  schema: JsonSchema,
  data: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof schema.$ref === "string") {
    validateNode(root, resolveRef(root, schema.$ref), data, path, errors);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) {
      validateNode(root, sub, data, path, errors);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    const matched = branches.some((sub) => {
      const local: ValidationError[] = [];
      validateNode(root, sub, data, path, local);
      return local.length === 0;
    });
    if (!matched) {
      errors.push({ path, message: "value did not match any anyOf branch" });
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push({
        path,
        message: `expected type ${types.join("|")}, got ${typeOf(data)}`,
      });
      return;
    }
  }

  if ("const" in schema && !deepEqual(data, schema.const)) {
    errors.push({
      path,
      message: `expected const ${JSON.stringify(schema.const)}`,
    });
  }

  if (Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).some((opt) => deepEqual(opt, data))) {
      errors.push({
        path,
        message: `value not in enum ${JSON.stringify(schema.enum)}`,
      });
    }
  }

  if (typeof data === "string") {
    if (typeof schema.pattern === "string") {
      if (!new RegExp(schema.pattern).test(data)) {
        errors.push({ path, message: `string does not match ${schema.pattern}` });
      }
    }
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push({ path, message: `string shorter than ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push({ path, message: `string longer than ${schema.maxLength}` });
    }
    if (schema.format === "date-time" && !DATE_TIME_RE.test(data)) {
      errors.push({ path, message: "string is not an RFC3339 date-time" });
    }
    if (schema.format === "uri" && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(data)) {
      errors.push({ path, message: "string is not a URI" });
    }
  }

  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push({ path, message: `number below minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push({ path, message: `number above maximum ${schema.maximum}` });
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      data <= schema.exclusiveMinimum
    ) {
      errors.push({
        path,
        message: `number not above exclusiveMinimum ${schema.exclusiveMinimum}`,
      });
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      data >= schema.exclusiveMaximum
    ) {
      errors.push({
        path,
        message: `number not below exclusiveMaximum ${schema.exclusiveMaximum}`,
      });
    }
  }

  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push({ path, message: `array shorter than ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push({ path, message: `array longer than ${schema.maxItems}` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < data.length; i += 1) {
        for (let j = i + 1; j < data.length; j += 1) {
          if (deepEqual(data[i], data[j])) {
            errors.push({ path, message: `array items ${i} and ${j} are equal` });
          }
        }
      }
    }
    if (schema.items && typeof schema.items === "object") {
      data.forEach((item, index) => {
        validateNode(
          root,
          schema.items as JsonSchema,
          item,
          `${path}[${index}]`,
          errors,
        );
      });
    }
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in record)) {
          errors.push({ path: `${path}.${key}`, message: "missing required property" });
        }
      }
    }
    const properties = (schema.properties as Record<string, JsonSchema>) ?? {};
    for (const [key, value] of Object.entries(record)) {
      const childPath = `${path}.${key}`;
      if (properties[key]) {
        validateNode(root, properties[key], value, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath, message: "additional property not allowed" });
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateNode(
          root,
          schema.additionalProperties as JsonSchema,
          value,
          childPath,
          errors,
        );
      }
    }
  }
}

export function validate(
  schema: JsonSchema,
  data: unknown,
  rootSchema: JsonSchema = schema,
): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(rootSchema, schema, data, "$", errors);
  return errors;
}

export function isValid(schema: JsonSchema, data: unknown): boolean {
  return validate(schema, data).length === 0;
}

/**
 * Structural sanity check that a loaded object is itself a usable JSON Schema
 * document for this validator (has an object root with $schema and a type or
 * properties). Not a full meta-schema check.
 */
export function assertSchemaShape(schema: unknown, name: string): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${name}: schema root must be an object`);
  }
  const record = schema as JsonSchema;
  if (typeof record.$schema !== "string") {
    throw new Error(`${name}: missing $schema`);
  }
  if (record.type === undefined && record.properties === undefined) {
    throw new Error(`${name}: schema must declare a type or properties`);
  }
  return record;
}
