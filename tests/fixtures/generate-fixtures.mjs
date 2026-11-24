import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
execFileSync('python', [path.join(__dirname, 'generate_fixtures.py')], { stdio: 'inherit' });
