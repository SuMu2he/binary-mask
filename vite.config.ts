import { defineConfig } from 'vite';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') ?? '';

export default defineConfig({
  base: `${basePath}/`,
});
