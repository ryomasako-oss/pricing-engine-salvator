# Silvy agent-service. Build from the REPO ROOT so ../shared is in the context:
#   docker build -f agent-service/Dockerfile -t silvy-agent .
FROM node:24-slim
WORKDIR /app

# shared/*.ts is imported by the agent; the root package.json's "type":"module"
# makes tsx treat it as ESM, exactly as in the repo checkout.
RUN printf '{"private":true,"type":"module"}\n' > /app/package.json

COPY agent-service/package.json agent-service/package-lock.json agent-service/
RUN cd agent-service && npm ci --omit=dev --ignore-scripts

COPY shared shared
COPY agent-service/src agent-service/src
COPY agent-service/tsconfig.json agent-service/

ENV NODE_ENV=production \
    AGENT_DB_PATH=/tmp/agent-knowledge.db
# Cloud Run sets PORT; the agent reads AGENT_PORT first, so map it in the command.
WORKDIR /app/agent-service
USER node
CMD ["sh", "-c", "AGENT_PORT=${PORT:-8888} exec npx tsx src/index.ts"]
