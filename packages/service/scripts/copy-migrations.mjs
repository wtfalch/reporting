import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/migrations', { recursive: true });
await cp('src/migrations', 'dist/migrations', { recursive: true });
