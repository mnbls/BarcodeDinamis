// PM2 process file:  pm2 start ecosystem.config.cjs --env production && pm2 save
//
// Cluster mode runs several workers. That is safe here: sessions live in PostgreSQL and every scan
// write is an atomic SQL statement. Rate limits and the (optional) redirect cache are per worker.
module.exports = {
  apps: [
    {
      name: 'dynamic-barcode',
      script: 'src/server.js',
      exec_mode: 'cluster',
      instances: process.env.WEB_CONCURRENCY || 2,
      max_memory_restart: '400M',
      kill_timeout: 20000, // let in-flight requests and scan writes finish (server.js drains on SIGINT)
      listen_timeout: 15000,
      time: true,
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
