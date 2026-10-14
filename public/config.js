// Configuração do front. Modo DEMO por padrão (dados fictícios, sem servidor).
// Em operação: o servidor local gera este arquivo sozinho (live: true) e, no Vercel, o build
// o gera a partir de TTF_API_URL (ver scripts/build-static.mjs e docs/piloto.md).
window.__TTF__ = { live: false, apiUrl: '' };
