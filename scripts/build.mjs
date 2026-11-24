/**
 * Sprite Sheet Builder V2.0 — Zero-Dependency Single-File Offline HTML Bundler.
 * Resolves ES modules starting at src/ui/app.js, transforms import/export cleanly into
 * an isolated in-memory module registry, inlines CSS + JS into dist/sprite-sheet-builder.html
 * so the output runs directly via file:// in Chrome & Edge with zero external requests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.resolve(ROOT, 'src/ui/app.js');
const HTML_TEMPLATE = path.resolve(ROOT, 'src/ui/index.html');
const CSS_FILE = path.resolve(ROOT, 'src/ui/styles.css');
const OUT_DIR = path.resolve(ROOT, 'dist');
const OUT_HTML = path.resolve(OUT_DIR, 'sprite-sheet-builder.html');

const modules = new Map(); // absPath -> { id, code }

function toModuleId(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(base + '.js')) return base + '.js';
  throw new Error(`Cannot resolve import "${spec}" from "${fromFile}"`);
}

function transformModule(absPath) {
  if (modules.has(absPath)) return;
  // Reserve slot to prevent cycles
  modules.set(absPath, null);

  let src = fs.readFileSync(absPath, 'utf8');
  const deps = [];

  // Transform static ES imports (handles multiline `import { a, b } from './x.js';` and `import * as x from ...`)
  src = src.replace(
    /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_, clause, spec) => {
      const target = resolveImport(absPath, spec);
      deps.push(target);
      const id = toModuleId(target);
      const trimmed = clause.trim();

      if (trimmed.startsWith('* as ')) {
        const alias = trimmed.slice(5).trim();
        return `const ${alias} = __req(${JSON.stringify(id)});`;
      }
      if (trimmed.startsWith('{')) {
        const inner = trimmed.slice(1, trimmed.lastIndexOf('}')).replace(/\s+as\s+/g, ': ');
        return `const { ${inner} } = __req(${JSON.stringify(id)});`;
      }
      if (trimmed.includes('{')) {
        const commaIdx = trimmed.indexOf(',');
        const defName = trimmed.slice(0, commaIdx).trim();
        const bracePart = trimmed.slice(commaIdx + 1).trim();
        const inner = bracePart.slice(1, bracePart.lastIndexOf('}')).replace(/\s+as\s+/g, ': ');
        return `const __m_${defName} = __req(${JSON.stringify(id)}); const ${defName} = __m_${defName}.default; const { ${inner} } = __m_${defName};`;
      }
      return `const ${trimmed} = __req(${JSON.stringify(id)}).default;`;
    }
  );

  // Transform exports
  const exportedNames = [];

  // export async function foo(...) / export function foo(...)
  src = src.replace(
    /^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
    (_, asyncKw, name) => {
      exportedNames.push(name);
      return `${asyncKw || ''}function ${name}`;
    }
  );

  // export class Foo
  src = src.replace(
    /^export\s+class\s+([A-Za-z0-9_$]+)/gm,
    (_, name) => {
      exportedNames.push(name);
      return `class ${name}`;
    }
  );

  // export const / let / var FOO
  src = src.replace(
    /^export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/gm,
    (_, kw, name) => {
      exportedNames.push(name);
      return `${kw} ${name}`;
    }
  );

  // export { a, b as c };
  src = src.replace(
    /^export\s*\{([^}]+)\}\s*;?/gm,
    (_, list) => {
      const pairs = list.split(',').map((s) => s.trim()).filter(Boolean);
      const assigns = [];
      for (const p of pairs) {
        const parts = p.split(/\s+as\s+/);
        const local = parts[0].trim();
        const exp = (parts[1] || parts[0]).trim();
        assigns.push(`exports.${exp} = ${local};`);
      }
      return assigns.join('\n');
    }
  );

  // Append explicit exports assignments
  if (exportedNames.length > 0) {
    src += '\n' + exportedNames.map((n) => `exports.${n} = ${n};`).join('\n') + '\n';
  }

  for (const dep of deps) {
    transformModule(dep);
  }

  modules.set(absPath, {
    id: toModuleId(absPath),
    code: src
  });
}

function build() {
  transformModule(ENTRY);

  const registryEntries = [];
  for (const mod of modules.values()) {
    registryEntries.push(
      `${JSON.stringify(mod.id)}: function(exports, __req) {\n${mod.code}\n}`
    );
  }

  const bundleJs = `(function() {\n'use strict';\nconst __mods = {\n${registryEntries.join(',\n')}\n};\nconst __cache = Object.create(null);\nfunction __req(id) {\n  if (__cache[id]) return __cache[id];\n  const exports = {};\n  __cache[id] = exports;\n  if (!__mods[id]) throw new Error('Missing module: ' + id);\n  __mods[id](exports, __req);\n  return exports;\n}\n__req(${JSON.stringify(toModuleId(ENTRY))});\n})();`;

  // Escape </script> inside inline JS if ever present
  const safeJs = bundleJs.replace(/<\/script>/gi, '<\\/script>');
  const css = fs.readFileSync(CSS_FILE, 'utf8');
  const htmlTemplate = fs.readFileSync(HTML_TEMPLATE, 'utf8');

  const finalHtml = htmlTemplate
    .replace('<!-- INLINE_CSS_PLACEHOLDER -->', () => `<style>\n${css}\n</style>`)
    .replace('<!-- INLINE_JS_PLACEHOLDER -->', () => `<script>\n${safeJs}\n</script>`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_HTML, finalHtml, 'utf8');

  const sizeBytes = Buffer.byteLength(finalHtml, 'utf8');
  const sizeKiB = (sizeBytes / 1024).toFixed(1);
  console.log(`Built ${OUT_HTML} (${sizeBytes} bytes / ${sizeKiB} KiB, ${modules.size} modules)`);
  if (sizeBytes > 1024 * 1024) {
    console.warn('WARNING: Output HTML exceeds 1 MiB target!');
  }
}

build();
