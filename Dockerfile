FROM node:current-alpine AS iris-base

#ARG NODE_ENV=production
ARG NODE_ENV=test
ENV NODE_ENV=$NODE_ENV

ENV BUILD_DEPENDENCIES \
  python3 \
  make \
  g++
ENV TEST_DEPENDENCIES \
  git

RUN mkdir -p /app
WORKDIR /app

COPY package.json yarn.lock ./

RUN apk update && apk upgrade \
  && apk add --no-cache --virtual .build-dependencies $BUILD_DEPENDENCIES \
  && apk add --no-cache $TEST_DEPENDENCIES
RUN yarn install
RUN apk del .build-dependencies

# ============================================= #

FROM iris-base AS iris-store
COPY . .
CMD ["yarn", "start"]

# ============================================= #

FROM iris-base AS iris-store-dev
COPY . .
CMD ["yarn", "dev"]
