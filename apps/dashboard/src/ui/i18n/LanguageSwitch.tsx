import { useI18n } from "./context.js";

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="lang-switch" role="group" aria-label={t("common.messages.languageToggle")}>
      <button
        type="button"
        className={`lang-button ${locale === "fr" ? "active" : ""}`}
        onClick={() => setLocale("fr")}
        aria-pressed={locale === "fr"}
        title="Passer en français"
      >
        FR
      </button>
      <span className="lang-separator" aria-hidden="true">
        /
      </span>
      <button
        type="button"
        className={`lang-button ${locale === "en" ? "active" : ""}`}
        onClick={() => setLocale("en")}
        aria-pressed={locale === "en"}
        title="Switch to English"
      >
        EN
      </button>
    </div>
  );
}
