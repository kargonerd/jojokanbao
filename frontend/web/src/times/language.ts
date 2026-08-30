import type { TimesArticleTranslation, TimesDeliveryArticle } from "@jojo/content";

export type TimesForeignContentLanguage = "zh-CN" | "original";

export type TimesPresentedArticle = TimesDeliveryArticle & {
  originalLanguage: string;
  translationAvailable: boolean;
  usingTranslation: boolean;
};

export function preferredTimesTranslation(article: TimesDeliveryArticle): TimesArticleTranslation | undefined {
  const translation = article.translations?.["zh-CN"];
  if (!translation || translation.language !== "zh-CN" || typeof translation.title !== "string"
    || typeof translation.articleObject !== "string") return undefined;
  return translation;
}

export function presentTimesArticle(
  article: TimesDeliveryArticle,
  preference: TimesForeignContentLanguage,
): TimesPresentedArticle {
  const translation = preferredTimesTranslation(article);
  const usingTranslation = preference === "zh-CN" && Boolean(translation);
  return {
    ...article,
    ...(usingTranslation && translation ? {
      title: translation.title,
      summary: translation.summary ?? null,
      language: translation.language,
    } : {}),
    originalLanguage: article.source.language,
    translationAvailable: Boolean(translation),
    usingTranslation,
  };
}
