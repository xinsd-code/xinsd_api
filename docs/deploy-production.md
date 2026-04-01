# 生产部署文档

本文档适用于当前项目在 Linux 服务器上的生产部署，默认目录结构如下：

- 项目目录：`/var/www/xinsd-api`
- SQLite 数据目录：`/var/www/xinsd-api/data`
- 生产环境文件：`/var/www/xinsd-api/.env.production`
- 进程管理：`PM2`
- 反向代理：`Nginx`

当前方案不使用 GitHub Actions 自动同步代码。发布方式为：服务器保留完整 Git 仓库，手动执行 `git pull + npm ci + npm run build + pm2 reload`。

## 1. 服务器环境要求

- Ubuntu 22.04 / 24.04
- Node.js 20
- npm
- PM2
- Nginx
- Git
- build-essential

## 2. 安装基础环境

```bash
sudo apt update
sudo apt install -y curl git build-essential nginx

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo npm install -g pm2

node -v
npm -v
pm2 -v
```

## 3. 创建部署目录

```bash
sudo mkdir -p /var/www/xinsd-api
sudo chown -R $USER:$USER /var/www/xinsd-api
chmod -R 755 /var/www/xinsd-api
```

## 4. 拉取项目代码

如果服务器还没有代码：

```bash
cd /var/www
git clone <你的仓库地址> xinsd-api
cd /var/www/xinsd-api
```

如果服务器已经有代码：

```bash
cd /var/www/xinsd-api
git pull origin main
```

## 5. 创建数据目录

```bash
mkdir -p /var/www/xinsd-api/data
chmod -R 755 /var/www/xinsd-api/data
```

当前项目默认会把 SQLite 数据文件写入：

- `/var/www/xinsd-api/data/mock-data.db`

如果你未来想把数据目录迁到别处，可以调整 `.env.production` 中的 `DATA_DIR` 或 `SQLITE_DB_PATH`。

## 6. 配置生产环境变量

创建文件：

```bash
cd /var/www/xinsd-api
cp .env.example .env.production
```

推荐内容：

```env
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
DATA_DIR=/var/www/xinsd-api/data
PM2_APP_NAME=xinsd-api
```

如果你更希望固定 SQLite 文件路径，也可以改成：

```env
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
SQLITE_DB_PATH=/var/www/xinsd-api/data/mock-data.db
PM2_APP_NAME=xinsd-api
```

## 7. 安装依赖并构建

```bash
cd /var/www/xinsd-api
npm ci
npm run build
```

如果这一步失败，不要继续启动服务，先修构建问题。

## 8. 使用 PM2 启动

项目仓库已包含 `ecosystem.config.js`，可直接启动：

```bash
cd /var/www/xinsd-api
set -a
source .env.production
set +a
pm2 start ecosystem.config.js --only xinsd-api
pm2 save
```

查看进程：

```bash
pm2 list
pm2 logs xinsd-api --lines 100
```

## 9. 配置 PM2 开机自启

```bash
pm2 startup systemd -u $USER --hp $HOME
```

执行上面命令输出的那条 `sudo ...` 命令，然后执行：

```bash
pm2 save
systemctl status pm2-$USER
```

## 10. 配置 Nginx

如果你还没有域名，可以先用默认配置：

```bash
sudo tee /etc/nginx/sites-available/xinsd-api > /dev/null <<'EOF'
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
```

如果你有域名，比如 `api.example.com`，把 `server_name _;` 改成：

```nginx
server_name api.example.com;
```

启用配置：

```bash
sudo ln -sf /etc/nginx/sites-available/xinsd-api /etc/nginx/sites-enabled/xinsd-api
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
```

如果服务器启用了防火墙：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 11. 健康检查

当前项目已提供健康检查接口：

- `GET /api/health`

验证命令：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1
```

正常情况下，`/api/health` 会返回包含以下字段的 JSON：

- `status`
- `timestamp`
- `nodeEnv`
- `db.path`
- `db.exists`

## 12. 首次上线流程

```bash
cd /var/www/xinsd-api
cp .env.example .env.production
vi .env.production

mkdir -p /var/www/xinsd-api/data

npm ci
npm run build

set -a
source .env.production
set +a
pm2 start ecosystem.config.js --only xinsd-api
pm2 save

curl http://127.0.0.1:3000/api/health
```

确认应用本地可访问后，再由 Nginx 对外暴露。

## 13. 日常发布流程

后续每次发布直接在服务器执行：

```bash
cd /var/www/xinsd-api
git pull origin main
npm ci
npm run build

set -a
source .env.production
set +a
pm2 restart xinsd-api --update-env
pm2 save
```

如果是首次部署或 PM2 进程不存在，可以执行：

```bash
cd /var/www/xinsd-api
set -a
source .env.production
set +a
pm2 start ecosystem.config.js --only xinsd-api
pm2 save
```

## 14. 常用排查命令

查看应用状态：

```bash
pm2 list
pm2 status xinsd-api
```

查看日志：

```bash
pm2 logs xinsd-api --lines 200
```

查看端口占用：

```bash
ss -lntp | grep 3000
```

查看 Nginx 状态：

```bash
sudo systemctl status nginx
sudo nginx -t
```

## 15. 注意事项

- 当前项目依赖 `better-sqlite3`，必须在目标服务器上执行 `npm ci`。
- 不要把本地 `node_modules` 或本地构建产物直接拷到服务器运行。
- SQLite 数据文件不要再放在仓库根目录，应该放到 `data/`。
- 如果后续启用 HTTPS，建议再为 Nginx 配置证书。
- 如果部署用户和运行用户不同，需要单独处理 `/var/www/xinsd-api` 与 `data/` 的属主和权限。
