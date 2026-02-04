import TwigEngine, { type TwigOptions } from "./twig"

export async function evalTemplate(
  template: string,
  data: Record<string, any> = {},
  options: Partial<TwigOptions> = {}
) {
  return TwigEngine(options)
    .twig({ async: true, options, data: template })
    .render(data, undefined, true)
}

export async function evalExpr(
  expression: string,
  variables: Record<string, any> = {},
  options?: Partial<TwigOptions>
) {
  expression = expression.trim()
  if (expression.startsWith("{{") && expression.endsWith("}}")) {
    expression = expression.slice(2, -2)
  }
  const twig = TwigEngine(options)
  const compiled = twig.expression.compile({
    value: expression
  })
  const innerOptions = {
    template: {
      options: {}
    }
  }
  return await (twig.expression as any)["parseAsync"].call(
    innerOptions,
    compiled.stack,
    variables as any
  )
}

export async function evalObjectVals(
  val: unknown,
  variables: Record<string, any> = {},
  options?: Partial<TwigOptions>
) {
  return JSON.parse(await evalTemplate(JSON.stringify(val), variables, options))
}

export async function evalIterative(
  val: unknown,
  opts: { scope: Record<string, unknown>; deep?: boolean }
) {
  // TODO: configurable twig delimiters
  if (typeof val === "string") {
    // Only render if it looks like a template. Otherwise keep literal strings intact.
    if (/\{\{.*\}\}/.test(val)) {
      try {
        return await evalExpr(val, opts.scope)
      } catch {
        // If evaluation fails, keep original literal to avoid surprising failures.
        return val
      }
    }
    return val
  }

  if (opts.deep === false) return val

  if (Array.isArray(val)) {
    const out: unknown[] = []
    for (const item of val) {
      out.push(await evalIterative(item, opts))
    }
    return out
  }

  if (val && typeof val === "object") {
    const input = val as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      // merge progress into scope to allow left-to-right references

      out[k] = await evalIterative(v, {
        ...opts,
        scope: { ...opts.scope, ...out }
      })
    }
    return out
  }

  return val
}
