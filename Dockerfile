# Imagen base con Node 20 + Playwright + Xvfb listos
FROM apify/actor-node-playwright:latest

# Entorno
ENV NODE_ENV=production \
    APIFY_DISABLE_OUTDATED_WARNING=1 \
    PUPPETEER_SKIP_DOWNLOAD=true

# Instala dependencias (sin dev). Omitimos package-lock porque no lo usas.
COPY package.json ./
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . ./

# Validación de sintaxis (usa "test:syntax" del package.json)
RUN npm run test:syntax

# Entrada
CMD ["npm","start"]
