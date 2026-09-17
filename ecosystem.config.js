module.exports = {
  apps: [
    {
      name: "konter-bot",
      script: "./src/index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: ["src", "bot"],
      ignore_watch: ["node_modules", "docs", "scripts"],
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
