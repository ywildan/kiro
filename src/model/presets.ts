export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv?: string;
  local?: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'together',
    label: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    local: true,
  },
];

export const CUSTOM_PRESET: ProviderPreset = {
  id: 'custom',
  label: 'Custom endpoint',
  baseUrl: '',
};

export function allPresets(): ProviderPreset[] {
  return [...PRESETS, CUSTOM_PRESET];
}

export function presetById(id: string): ProviderPreset | undefined {
  return allPresets().find((preset) => preset.id === id);
}

export function presetDisplayName(baseUrl: string): string {
  const preset = PRESETS.find((entry) => entry.baseUrl === baseUrl.replace(/\/+$/, ''));
  return preset?.label ?? 'custom';
}
