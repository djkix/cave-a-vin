FROM node:22-alpine AS build
WORKDIR /app
# Sans le paquet openssl, Prisma ne détecte pas la version d'OpenSSL et retombe
# sur « openssl-1.1.x », donc sur un moteur que cette image ne peut pas charger.
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
# Garde-fou : `prisma --version` charge réellement les moteurs de requête et de
# schéma. Une incompatibilité OpenSSL casse donc le build (et la CI) au lieu de
# ne se révéler qu'au premier démarrage du conteneur.
RUN npx prisma --version
COPY --from=build /app/dist ./dist
COPY data ./data
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
