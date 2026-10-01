import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Glob } from "bun";

const sourceRoot = resolve(import.meta.dir, "../../../src");
const forbiddenPackages = ["@nestjs/", "@mikro-orm/", "@aws-sdk/"];
const importPattern =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

type Layer = "domain" | "application" | "infrastructure" | "interfaces";

const allowedLayers: Record<"domain" | "application", readonly Layer[]> = {
  domain: ["domain"],
  application: ["domain", "application"],
};

function extractImports(source: string): string[] {
  return [...source.matchAll(importPattern)].map((match) => match.slice(1).find(Boolean) ?? "");
}

function sourceFilesOf(layer: Layer): string[] {
  const directory = join(sourceRoot, layer);
  if (!existsSync(directory)) {
    return [];
  }
  return [...new Glob("**/*.ts").scanSync({ cwd: directory, absolute: true })];
}

function layerOf(absolutePath: string): string | undefined {
  const [first] = relative(sourceRoot, absolutePath).split(sep);
  return first;
}

function violationsOf(layer: "domain" | "application"): string[] {
  return sourceFilesOf(layer).flatMap((file) =>
    extractImports(readFileSync(file, "utf8")).flatMap((specifier) => {
      const location = `${relative(sourceRoot, file)} → ${specifier}`;
      if (forbiddenPackages.some((prefix) => specifier.startsWith(prefix))) {
        return [`${location} (forbidden package)`];
      }
      if (specifier.startsWith(".")) {
        const target = layerOf(resolve(dirname(file), specifier));
        if (!allowedLayers[layer].includes(target as Layer)) {
          return [`${location} (${layer} cannot depend on ${target})`];
        }
      }
      return [];
    }),
  );
}

describe("import scanner", () => {
  test("finds every import form, type-only imports included", () => {
    const source = [
      'import { Injectable } from "@nestjs/common";',
      'import type { EntityManager } from "@mikro-orm/core";',
      "import {",
      "  SQSClient,",
      "} from '@aws-sdk/client-sqs';",
      'import "reflect-metadata";',
      'export * from "./money";',
      'const lazy = await import("../infrastructure/x");',
      'const legacy = require("node:fs");',
    ].join("\n");

    expect(extractImports(source)).toEqual([
      "@nestjs/common",
      "@mikro-orm/core",
      "@aws-sdk/client-sqs",
      "reflect-metadata",
      "./money",
      "../infrastructure/x",
      "node:fs",
    ]);
  });
});

describe("dependency rule", () => {
  test("the domain layer exists, so the rule is not checked against nothing", () => {
    expect(sourceFilesOf("domain").length).toBeGreaterThan(0);
  });

  test("src/domain imports neither frameworks nor other layers", () => {
    expect(violationsOf("domain")).toEqual([]);
  });

  test("src/application imports neither frameworks nor infrastructure or interfaces", () => {
    expect(violationsOf("application")).toEqual([]);
  });
});
