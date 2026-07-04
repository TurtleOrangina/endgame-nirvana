FROM node:26-trixie

RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Claude Code
RUN npm install -g @anthropic-ai/claude-code &&\
    npm install -g vite-plus

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/home/node/.uv_venv
WORKDIR /workspace

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["claude"]