export default {
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    server: {
      deps: {
        inline: [/@solana/, /tweetnacl/, /vitest/],
      },
    },
  },
};
