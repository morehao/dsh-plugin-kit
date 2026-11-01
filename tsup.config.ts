import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    update: 'src/update.ts',
    'update-client': 'src/update-client.ts',
    http: 'src/http.ts',
    exec: 'src/exec.ts',
    fs: 'src/fs.ts',
    state: 'src/state.ts',
    github: 'src/github.ts',
    meta: 'src/meta.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
});
