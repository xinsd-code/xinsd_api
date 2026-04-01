module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'xinsd-api',
      cwd: process.cwd(),
      script: 'npm',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.PORT || '3000',
        HOSTNAME: process.env.HOSTNAME || '0.0.0.0',
        DATA_DIR: process.env.DATA_DIR || '/var/lib/api-forge',
      },
    },
  ],
};
