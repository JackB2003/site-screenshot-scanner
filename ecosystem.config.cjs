module.exports = {
  apps: [
    {
      name: 'site-screenshots',
      cwd: __dirname,
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: '3012',
      },
    },
  ],
};
