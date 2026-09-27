module.exports = {
  apps: [
    {
      name: "line-webhook",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 5000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
