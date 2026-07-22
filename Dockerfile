# Image officielle Node 22 (SQLite intégré, aucune dépendance à installer)
FROM node:22-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
# Coolify : mappe un volume persistant sur /app/data (pour garder la base entre les déploiements)

EXPOSE 8090
CMD ["node", "server.js"]
