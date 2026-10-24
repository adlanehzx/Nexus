/**
 * Real-time spoken voice translation adapter and pipeline.
 *
 * ## Principles
 * 1. Takes transcribed text from source language and maps to target language.
 * 2. Connects directly to local synthesis with target language voice model.
 * 3. Does not leak transcripts or synthesized audio to external cloud translators.
 */

export interface TranslationResult {
  readonly sourceText: string;
  readonly sourceLanguage: string;
  readonly translatedText: string;
  readonly targetLanguage: string;
  readonly confidence: number;
}

export type TranslatorFn = (
  text: string,
  sourceLang: string,
  targetLang: string,
) => Promise<{ translatedText: string; confidence: number }>;

export class SpokenVoiceTranslator {
  readonly #translator: TranslatorFn;

  constructor(translator: TranslatorFn) {
    this.#translator = translator;
  }

  async translateUtterance(
    sourceText: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<TranslationResult> {
    const trimmed = sourceText.trim();
    if (trimmed.length === 0) {
      return {
        sourceText: "",
        sourceLanguage,
        translatedText: "",
        targetLanguage,
        confidence: 1.0,
      };
    }

    if (sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
      return {
        sourceText: trimmed,
        sourceLanguage,
        translatedText: trimmed,
        targetLanguage,
        confidence: 1.0,
      };
    }

    const outcome = await this.#translator(trimmed, sourceLanguage, targetLanguage);
    return {
      sourceText: trimmed,
      sourceLanguage,
      translatedText: outcome.translatedText,
      targetLanguage,
      confidence: outcome.confidence,
    };
  }
}
