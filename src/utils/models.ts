export interface GroqModelOption {
  id: string;
  name: string;
  description: string;
  freeTierReady: boolean;
  supportsParallelTools: boolean;
  reasoningEffort?: 'low' | 'medium' | 'none';
}

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/**
 * Pool de modelos verificados no Plano Gratuito da Groq (cada um tem balde próprio de 8K TPM e 200K TPD!).
 * Quando um modelo atinge 429 (TPM ou TPD) ou 413, o agente alterna automaticamente para o próximo!
 */
export const FREE_TIER_MODEL_POOL: string[] = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
];

export const AVAILABLE_MODELS: GroqModelOption[] = [
  {
    id: 'openai/gpt-oss-120b',
    name: 'GPT OSS 120B (Padrão Recomendado · Free Tier)',
    description: '120B parâmetros · Raciocínio médio (pensa mais antes de editar) · 8K TPM / 200K TPD grátis',
    freeTierReady: true,
    supportsParallelTools: false,
    reasoningEffort: 'medium',
  },
  {
    id: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B (Especialista em Código · Free Tier)',
    description: 'Excelente em edição cirúrgica + chamadas paralelas · 8K TPM / 200K TPD grátis',
    freeTierReady: true,
    supportsParallelTools: true,
    reasoningEffort: 'none',
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'GPT OSS 20B (Ultra Rápido 1.000 tok/s · Free Tier)',
    description: 'Velocidade instantânea e reserva automática de cota · 8K TPM / 200K TPD grátis',
    freeTierReady: true,
    supportsParallelTools: false,
    reasoningEffort: 'low',
  },
  {
    id: 'moonshotai/kimi-k2-instruct-0905',
    name: 'Kimi K2 Instruct 09-05 (Dev/Paid Tier)',
    description: 'Disponível para contas com plano Dev Tier ativo',
    freeTierReady: false,
    supportsParallelTools: true,
  },
  {
    id: 'meta-llama/llama-4-scout-17b-16e-instruct',
    name: 'Llama 4 Scout 17B (Dev/Paid Tier)',
    description: 'Modelo multimodal rápido (se habilitado na conta)',
    freeTierReady: false,
    supportsParallelTools: true,
  },
];

export function supportsParallelToolCalls(modelId: string): boolean {
  const found = AVAILABLE_MODELS.find(m => m.id === modelId);
  if (found) return found.supportsParallelTools;
  if (modelId.includes('gpt-oss') || modelId.includes('allam')) return false;
  return true;
}

export function getOptimalReasoningEffort(modelId: string): 'low' | 'medium' | 'none' | undefined {
  const found = AVAILABLE_MODELS.find(m => m.id === modelId);
  if (found) return found.reasoningEffort;
  if (modelId.startsWith('openai/gpt-oss')) return 'low';
  if (modelId.startsWith('qwen/qwen3')) return 'none';
  return undefined;
}
