import type { ProfileConfig } from '../config.js';
import { OpenAIProvider } from './openai.js';
import type { Provider } from './types.js';

export function createProvider(profile: ProfileConfig, apiKey: string | undefined): Provider {
  switch (profile.type) {
    case 'openai':
      return new OpenAIProvider(profile, apiKey);
    default:
      throw new Error(
        `Unsupported provider type "${profile.type}". Phase 1 only supports "openai"-compatible endpoints.`,
      );
  }
}
