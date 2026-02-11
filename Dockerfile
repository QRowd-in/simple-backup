FROM oven/bun:1 AS base

# Install postgresql-client (for pg_dump) and gzip
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client gzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY index.ts ./

CMD ["bun", "run", "index.ts"]
