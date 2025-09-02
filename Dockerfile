FROM apify/actor-node-playwright-chrome:20

COPY . ./
RUN npm install --omit=dev

CMD ["npm", "start"]
