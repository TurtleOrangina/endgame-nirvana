FROM node:24-trixie

RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Claude Code. vite-plus is installed globally so `vp` exists before the project's
# dependencies are installed, but the project-local copy has to win once they are: the
# global one's bundled Vitest resolves a test's environment package (jsdom, a devDependency
# of frontend/) next to itself and fails every test file before it runs. The local shim
# exports the NODE_PATH that makes that resolution work, so it goes first on PATH.
RUN npm install -g @anthropic-ai/claude-code &&\
    npm install -g vite-plus

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/home/node/.uv_venv \
    TZ="Europe/Berlin" \
    PATH="/workspace/frontend/node_modules/.bin:${PATH}"

WORKDIR /workspace

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["claude"]
