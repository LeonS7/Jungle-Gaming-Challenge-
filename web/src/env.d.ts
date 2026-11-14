/** Esta página declara os tipos das variáveis de ambiente do Vite.
 * Assinatura: Leonardo de Souza da Luz
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
