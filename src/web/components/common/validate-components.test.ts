// Tests for scripts/validate-components.mjs (runs the real script with node on fixture files in a
// private tmp/validator-fixtures-* folder: overlapping test runs never share or delete each other's files).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/validate-components.mjs');
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
const DIR = fs.mkdtempSync(path.join(ROOT, 'tmp', 'validator-fixtures-'));

function run(...targets: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...targets], { encoding: 'utf8', cwd: ROOT });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function write(name: string, code: string): string {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, code);
  return p;
}

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('validate-components script', () => {
  it('passes a component with a Props interface and theme classes', () => {
    const f = write('Good.tsx', `export interface GoodProps { readonly x: string }\nexport function Good(p: Readonly<GoodProps>) { return <div className={\`bg-felt \${p.x ? 'text-ink' : 'text-ink-muted'}\`} />; }\n`);
    const r = run(f);
    expect(r.code).toBe(0);
    expect(r.out).toContain('checked 1 file');
  });

  it('fails a component without a *Props interface', () => {
    const f = write('NoProps.tsx', `export function NoProps() { return <div className="bg-felt" />; }\n`);
    const r = run(f);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MISSING');
  });

  it('fails hex colours in className literals, templates and nested expressions', () => {
    const lit = write('HexLiteral.tsx', `export interface AProps {}\nexport const A = () => <div className="bg-[#ba1a1a]" />;\n`);
    const tpl = write('HexTemplate.tsx', `export interface BProps { on: boolean }\nexport const B = (p: BProps) => <div className={\`p-2 \${p.on ? 'text-[#fff]' : ''}\`} />;\n`);
    for (const f of [lit, tpl]) {
      const r = run(f);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/hex colour #[0-9a-fA-F]+/);
    }
  });

  it('ignores test files and hex codes outside className', () => {
    write('Thing.test.tsx', `export const t = <div className="bg-[#000]" />;\n`);
    const f = write('Svg.tsx', `export interface SvgProps {}\nexport const S = () => <svg><rect fill="#e2c974" /></svg>;\n`);
    expect(run(f).code).toBe(0);
  });

  it('passes on the dashboard files owned by the integration agent', () => {
    const r = run('src/web/App.tsx', 'src/web/components/common', 'src/web/components/layout', 'src/web/components/panels');
    expect(r.out).not.toContain('✗');
    expect(r.code).toBe(0);
  });
});
