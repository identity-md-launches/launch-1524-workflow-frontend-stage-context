import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Development serves the already-generated manifest and its ABIs from the same
// export used in production. No second address/configuration map is introduced.
const deploymentInDevelopment: Plugin = {
  name: 'exported-deployment-in-development',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const path = request.url?.split('?')[0];
      if (!path || !/^\/(?:imd-deployment\.json|abi\/[A-Za-z0-9_]+\.json)$/.test(path)) return next();
      try {
        const bytes = await readFile(fileURLToPath(new URL(`../dist${path}`, import.meta.url)));
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(bytes);
      } catch {
        response.statusCode = 503;
        response.end('Run npm run build to generate the verified deployment configuration.');
      }
    });
  },
};

export default defineConfig({
  base: './',
  plugins: [deploymentInDevelopment],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
