# Imagen base con Node 20 + Playwright + Xvfb listos
FROM apify/actor-node-playwright:latest

# Más seguro y reproducible
ENV NODE_ENV=production \
    APIFY_DISABLE_OUTDATED_WARNING=1 \
    PUPPETEER_SKIP_DOWNLOAD=true

# Copiamos definición de dependencias
COPY package.json package-lock.json* ./

# Instalamos sólo prod dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copiamos el resto del código
COPY . ./

# Valida sintaxis antes de ejecutar (opcional)
RUN npm run test:syntax

# Comando por defecto
CMD ["npm","start"]
