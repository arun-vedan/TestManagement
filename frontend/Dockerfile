# Production image for the vedan frontend.
#
# There was none: the app only ever ran through `npm start` (craco's dev
# server), which is not something to put on the internet — it ships source
# maps, an unminified bundle and a websocket for hot reload.
#
# THE THING THAT CATCHES PEOPLE OUT: Create React App inlines every
# REACT_APP_* variable into the JavaScript bundle AT BUILD TIME. They are not
# read at runtime, so the same image cannot be pointed at a different API by
# changing an environment variable on the container. The URLs below are build
# arguments for that reason, and an image built for staging genuinely cannot
# serve production. If that becomes painful, the fix is a runtime config file
# the app fetches on boot — deliberately not done here, because it adds a
# moving part this deployment does not yet need.

FROM node:20-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json* ./
# `npm ci` requires a lock file and this repo commits none —
# frontend/.gitignore:25 excludes package-lock.json. It works on a
# developer's machine, where the lock exists on disk, and fails in CI,
# where the context is the git checkout. Fall back rather than depend on
# a file that is deliberately not tracked.
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

# Baked into the bundle. Defaults match the dev stack so a plain `docker build`
# still produces something that works locally.
ARG REACT_APP_API_BASE_URL=http://localhost:8000
ARG REACT_APP_KEYCLOAK_BASE_URL=http://localhost:8080
ENV REACT_APP_API_BASE_URL=$REACT_APP_API_BASE_URL
ENV REACT_APP_KEYCLOAK_BASE_URL=$REACT_APP_KEYCLOAK_BASE_URL

# CI=true makes the build treat warnings as errors, which is what the CI job
# relies on; keeping it here means the image cannot be built from code that
# would fail CI.
ENV CI=true
RUN npm run build

FROM nginx:1.27-alpine AS runtime

# nginx's default config serves 404 for client-side routes; this one does not.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html

# Traefik terminates TLS and talks to this over the internal network, so plain
# HTTP on 80 inside the container is correct — not a downgrade.
EXPOSE 80

# Fails the container's healthcheck if nginx is up but the bundle is missing,
# which is otherwise a silent white page.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost/index.html >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
