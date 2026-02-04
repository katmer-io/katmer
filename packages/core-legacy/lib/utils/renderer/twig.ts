import type { Twig } from "twig"

import core from "twig/src/twig.core"
import compiler from "twig/src/twig.compiler"
import expression from "twig/src/twig.expression"
import filters from "twig/src/twig.filters"
import functionsMod from "twig/src/twig.functions"
import lib from "twig/src/twig.lib"
import logic from "twig/src/twig.logic"
import parserSource from "twig/src/twig.parser.source"
import parserTwig from "twig/src/twig.parser.twig"
import pathMod from "twig/src/twig.path"
import testMod from "twig/src/twig.tests"
import asyncMod from "twig/src/twig.async"
import exportsMod from "twig/src/twig.exports"

import esToolkit from "es-toolkit/compat"

import * as localFunctions from "./render_functions"
export interface TwigOptions {
  delimiters: Partial<{
    comment: [string, string]
    block: [string, string]
    variable: [string, string]
    interpolation: [string, string]
  }>
}

const InstanceCache = {} as Record<string, any>
export default function (
  opts: Partial<TwigOptions> = {}
): Twig["exports"] & { expression: Twig["expression"] } {
  const k = JSON.stringify(opts)
  if (InstanceCache[k]) {
    return InstanceCache[k]
  }

  const Twig = {
    VERSION: "1.17.1"
  } as any

  core(Twig)
  compiler(Twig)
  expression(Twig)
  filters(Twig)
  functionsMod(Twig)
  lib(Twig)
  logic(Twig)
  parserSource(Twig)
  parserTwig(Twig)
  pathMod(Twig)
  testMod(Twig)
  asyncMod(Twig)
  exportsMod(Twig)

  const delimiters = Object.assign(
    {
      comment: ["{#", "#}"],
      block: ["{%", "%}"],
      variable: ["{{", "}}"],
      interpolation: ["#{", "}"]
    },
    opts.delimiters
  ) as Required<TwigOptions["delimiters"]>

  Twig.token.definitions = [
    {
      type: Twig.token.type.raw,
      open: `${delimiters.block[0]} raw ${delimiters.block[1]}`,
      close: `${delimiters.block[0]} endraw ${delimiters.block[1]}`
    },
    {
      type: Twig.token.type.raw,
      open: `${delimiters.block[0]} verbatim ${delimiters.block[1]}`,
      close: `${delimiters.block[0]} endverbatim ${delimiters.block[1]}`
    },
    // *Whitespace type tokens*
    //
    // These typically take the form `{{- expression -}}` or `{{- expression }}` or `{{ expression -}}`.
    {
      type: Twig.token.type.outputWhitespacePre,
      open: `${delimiters.variable[0]}-`,
      close: `${delimiters.variable[1]}`
    },
    {
      type: Twig.token.type.outputWhitespacePost,
      open: `${delimiters.variable[0]}`,
      close: `-${delimiters.variable[1]}`
    },
    {
      type: Twig.token.type.outputWhitespaceBoth,
      open: `${delimiters.variable[0]}-`,
      close: `-${delimiters.variable[1]}`
    },
    {
      type: Twig.token.type.logicWhitespacePre,
      open: `${delimiters.block[0]}-`,
      close: `${delimiters.block[1]}`
    },
    {
      type: Twig.token.type.logicWhitespacePost,
      open: `${delimiters.block[0]}`,
      close: `-${delimiters.block[1]}`
    },
    {
      type: Twig.token.type.logicWhitespaceBoth,
      open: `${delimiters.block[0]}-`,
      close: `-${delimiters.block[1]}`
    },
    // *Output type tokens*
    // These typically take the form `{{ expression }}`.
    {
      type: Twig.token.type.output,
      open: `${delimiters.variable[0]}`,
      close: `${delimiters.variable[1]}`
    },
    // *Logic type tokens*
    // These typically take a form like `{% if expression %}` or `{% endif %}`
    {
      type: Twig.token.type.logic,
      open: delimiters.block[0],
      close: delimiters.block[1]
    },
    // *Comment type tokens*
    // These take the form `{# anything #}`
    {
      type: Twig.token.type.comment,
      open: delimiters.comment[0],
      close: delimiters.comment[1]
    }
  ]

  Twig.functions["indent"] = Twig.filters["indent"] = function (
    text?: string,
    params: any[] = []
  ) {
    const [count = 2] = params
    const spaces = " ".repeat(count)

    return text
      ?.split("\n")
      .map((line) => (line ? spaces + line : line))
      .join("\n")
  }

  Twig.filter = function (filter: string, value: any, params = []) {
    if (filter === "replaceAll") {
      return value.replaceAll(...params)
    }
    if (
      filter in esToolkit &&
      typeof (esToolkit as any)[filter] === "function"
    ) {
      return (esToolkit as any)[filter](
        value,
        ...(typeof params === "object" ? params : [params])
      )
    }
    if (!Twig.filters[filter]) {
      throw new Twig.Error("Unable to find filter " + filter)
    }
    return Twig.filters[filter].call(this, value, params || [])
  }

  Twig.functions = new Proxy(
    { ...Twig.functions },
    {
      get(target, prop) {
        if (
          prop in localFunctions &&
          typeof (localFunctions as any)[prop] === "function"
        ) {
          return (localFunctions as any)[prop]
        }
        if (
          prop in esToolkit &&
          typeof (esToolkit as any)[prop] === "function"
        ) {
          return (esToolkit as any)[prop]
        }
        if (target[prop]) {
          return target[prop]
        }
        return undefined
      }
    }
  )
  Twig.exports["expression"] = Twig.expression
  InstanceCache[k] = Twig.exports
  return Twig.exports
}
