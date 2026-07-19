import { defineConfig } from 'vite';

// base './' — GitHub Pages의 프로젝트 하위 경로(https://<user>.github.io/<repo>/)에서도 동작
export default defineConfig({
  base: './',
});
