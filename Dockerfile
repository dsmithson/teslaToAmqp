FROM node:16

# To Create nodejsapp directory
WORKDIR /nodejsapp

# To Install All dependencies
COPY src/tesla-app.js ./
COPY src/package*.json ./

RUN npm install

CMD [ "node", "tesla-app.js" ]