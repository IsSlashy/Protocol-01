export default {
  esbuild: {
    tsconfigRaw: '{"compilerOptions":{"target":"ES2020","module":"ESNext","moduleResolution":"bundler","lib":["ES2020","DOM"],"strict":true,"esModuleInterop":true,"skipLibCheck":true}}',
  },
  test: {
    globals: true,
    environment: 'node',
  },
};
