FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Healthcheck necesita wget (ya viene en alpine)
RUN apk add --no-cache wget

# Instalar dependencias primero para aprovechar el cache de capas
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Codigo de la app
COPY server.js ./
COPY src ./src
COPY public ./public
COPY sql ./sql
COPY scripts ./scripts

# Directorio de las sesiones (ver el comentario de session() en server.js).
# Se crea AQUI, con dueno `node`, y no se deja que lo cree Docker al montar
# el volumen: un volumen sobre una ruta que no existe en la imagen lo crea
# Docker como root, y el contenedor corre como `node` (USER de abajo), que
# entonces no podria escribir y toda peticion fallaria. Creandolo antes, el
# volumen hereda este dueno.
RUN mkdir -p /app/.sesiones && chown -R node:node /app/.sesiones

EXPOSE 8011

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8011/healthz || exit 1

USER node
CMD ["node", "server.js"]
