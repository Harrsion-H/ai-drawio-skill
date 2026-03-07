FROM node:25-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm install

FROM node:25-alpine
WORKDIR /app
COPY --from=build /app .

EXPOSE 3000
CMD ["npm", "start"]
