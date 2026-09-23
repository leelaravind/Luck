#!/usr/bin/env node
/**
 * Component validator for the Luck dashboard.
 *
 * Adapted from the Stitch "react-components" skill validator (scripts/validate.js,
 * Copyright 2026 Google LLC, Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: uses the TypeScript compiler API instead of @swc/core, scans a whole tree instead of one
 * file, and also inspects expressions inside className (template literals, ternaries, helper calls).
 *
 * Rules (for every .tsx under src/web/components and for src/web/App.tsx; tests are skipped):
 *   1. The file declares an interface whose name ends in "Props".
 *   2. No string inside a className attribute contains a hex colour (#abc, #aabbcc, #aabbccdd):
 *      colours must come from the theme tokens in src/web/styles/app.css.
 *
 * Usage: node scripts/validate-components.mjs [file-or-dir ...]
 * Exits 1 with a report when any file fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HEX_COLOR = /#[0-9A-Fa-f]{3,8}\b/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGETS = [path.join(ROOT, 'src/web/components'), path.join(ROOT, 'src/web/App.tsx')];

function collect(target, out) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) collect(path.join(target, entry), out);
  } else if (target.endsWith('.tsx') && !/\.test\.tsx$/.test(target) && !/[\\/]__tests__[\\/]/.test(target)) {
    out.push(target);
  }
}

/** Every string fragment reachable inside a className initializer. */
function classNameStrings(node, out) {
  if (!node) return;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push({ text: node.text, node });
    return;
  }
  if (ts.isTemplateExpression(node)) {
    out.push({ text: node.head.text, node: node.head });
    for (const span of node.templateSpans) {
      classNameStrings(span.expression, out);
      out.push({ text: span.literal.text, node: span.literal });
    }
    return;
  }
  ts.forEachChild(node, (child) => classNameStrings(child, out));
}

export function validateFile(file) {
  const code = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let hasPropsInterface = false;
  const hexIssues = [];

  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text.endsWith('Props')) hasPropsInterface = true;
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'className' && node.initializer) {
      const strings = [];
      classNameStrings(node.initializer, strings);
      for (const s of strings) {
        const m = HEX_COLOR.exec(s.text);
        if (m) {
          const { line, character } = sf.getLineAndCharacterOfPosition(s.node.getStart(sf));
          hexIssues.push({ hex: m[0], line: line + 1, column: character + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { file, hasPropsInterface, hexIssues };
}

function main(argv) {
  const targets = argv.length ? argv.map((a) => path.resolve(a)) : DEFAULT_TARGETS;
  const files = [];
  for (const t of targets) collect(t, files);
  files.sort();
  if (!files.length) {
    console.error('validate-components: no .tsx files found in', targets.join(', '));
    process.exit(1);
  }

  const failures = [];
  for (const file of files) {
    const r = validateFile(file);
    if (!r.hasPropsInterface || r.hexIssues.length) failures.push(r);
  }

  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  console.log(`validate-components: checked ${files.length} file(s).`);
  if (!failures.length) {
    console.log('All components declare a *Props interface and use theme colour tokens (no hex in className).');
    process.exit(0);
  }
  for (const f of failures) {
    console.error(`\n✗ ${rel(f.file)}`);
    if (!f.hasPropsInterface) console.error('  - MISSING: an interface whose name ends in "Props"');
    for (const h of f.hexIssues) console.error(`  - STYLE: hex colour ${h.hex} in className at ${h.line}:${h.column}`);
  }
  console.error(`\n${failures.length} of ${files.length} file(s) failed validation.`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
