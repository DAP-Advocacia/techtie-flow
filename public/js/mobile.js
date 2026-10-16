// Ponto de corte do layout de celular (igual ao @media (max-width: 820px) dos CSS).
export const MOBILE_QUERY = '(max-width: 820px)';
export const isMobile = () => matchMedia(MOBILE_QUERY).matches;
