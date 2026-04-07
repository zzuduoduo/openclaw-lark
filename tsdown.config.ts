import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  outDir: 'dist',
  // 禁用 .d.mts 类型定义生成（插件不需要导出类型给外部使用，减少构建时间）
  dts: false,
  deps: {
    neverBundle: [
      /^openclaw(\/.*)?$/,
      /^@larksuiteoapi\//,
      /^@sinclair\//,
      'image-size',
      'zod',
      /^node:/,
    ],
  },
});
