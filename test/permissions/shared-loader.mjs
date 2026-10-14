// Hook de resolução para testar módulos do FRONT em Node: no navegador "/shared/…" é a raiz do site
// (o servidor mapeia para a pasta shared/); aqui apontamos para o mesmo lugar do repositório.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/shared/')) return nextResolve(new URL(`../../shared${specifier.slice('/shared'.length)}`, import.meta.url).href, context);
  return nextResolve(specifier, context);
}
