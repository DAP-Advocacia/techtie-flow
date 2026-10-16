FROM node:22-bookworm-slim

# ffmpeg-static baixa um binário no postinstall e o código o referencia por
# caminho absoluto (src/audioConvert.js), então não precisamos do ffmpeg do
# sistema. As libs abaixo são o que esse binário linka em runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Camada separada para as dependências: só reinstala quando o lockfile muda.
COPY package.json package-lock.json ./

# --ignore-scripts quebraria o ffmpeg-static (ele baixa o binário no
# postinstall), por isso os scripts rodam normalmente aqui.
RUN npm ci --omit=dev

COPY . .

# A sessão do Baileys mora aqui. Precisa ser um volume persistente (Coolify/EasyPanel),
# senão o QR Code é pedido de novo a cada deploy.
ENV AUTH_FOLDER=/app/auth_session
RUN mkdir -p /app/auth_session

ENV NODE_ENV=production
ENV PORT=3333
EXPOSE 3333

# Saúde: a API responde /api/health (só existe com DATABASE_URL + AUTH_TOKEN_SECRET definidos).
# start-period generoso: o servidor religa as sessões do WhatsApp em fila ao subir.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3   CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
