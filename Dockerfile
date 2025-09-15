# Usamos la imagen base de Apify que ya tiene Playwright instalado
FROM apify/actor-node-playwright:latest

# Configuramos las variables de entorno
ENV NODE_ENV=production \
    APIFY_DISABLE_OUTDATED_WARNING=1 \
    PUPPETEER_SKIP_DOWNLOAD=true

# Copiamos el archivo package.json y el package-lock.json (si ya está disponible)
COPY package.json package-lock.json* ./

# Instalamos dependencias y generamos el package-lock.json si no está presente
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . ./

# Validamos la sintaxis de nuestro main.js (opcional)
RUN npm run test:syntax

# Comando por defecto cuando el contenedor se inicie
CMD ["npm", "start"]
