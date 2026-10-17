import type { Driver, DriverKind } from './contract';
import { ScriptedDriver } from './scripted';
import { OpenAICompatibleDriver, type OpenAICompatibleConfig } from './openai';
import { OllamaDriver, type OllamaConfig } from './ollama';

export * from './contract';
export { ScriptedDriver } from './scripted';
export { OpenAICompatibleDriver, type OpenAICompatibleConfig } from './openai';
export { OllamaDriver, type OllamaConfig } from './ollama';

export interface DriverSettings {
  kind: DriverKind;
  openai: OpenAICompatibleConfig;
  ollama: OllamaConfig;
}

export function createDriver(settings: DriverSettings): Driver {
  switch (settings.kind) {
    case 'openai':
      return new OpenAICompatibleDriver(settings.openai);
    case 'ollama':
      return new OllamaDriver(settings.ollama);
    case 'scripted':
    default:
      return new ScriptedDriver();
  }
}
