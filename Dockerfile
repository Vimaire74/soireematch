# Image officielle Node 22 (SQLite intégré)
FROM node:22-alpine

WORKDIR /app

# Dépendances (nodemailer) — installées d'abord pour profiter du cache
COPY package*.json ./
RUN npm install --omit=dev

# Code de l'application
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
# Coolify : mappe un volume persistant sur /app/data (pour garder la base entre les déploiements)

EXPOSE 8090
CMD ["node", "server.js"]
