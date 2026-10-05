module.exports = {
  apps: [
    {
      name: "line-webhook",
      script: "dist/index.js",
      cwd: __dirname,
      // D5：必須維持單一行程。sessions、rate-limit、nonce、idempotency、
      // stats/message 記憶體視窗、LINE/Baileys 長連線全部都在行程內，
      // instances > 1 會讓限流、重播保護、登入狀態同時失效。切勿改大。
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      // J6：index.ts 的強制結束是 10 秒，這裡必須更大，否則 PM2 會先 SIGKILL
      // 截斷 graceful shutdown（排程狀態可能遺失）。
      kill_timeout: 12000,
      max_memory_restart: "512M",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
