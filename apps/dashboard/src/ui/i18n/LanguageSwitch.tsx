import { useI18n } from "./context.js";
import { SegmentedControl } from "../kit/SegmentedControl.js";

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <SegmentedControl
      label={t("common.messages.languageToggle")}
      value={locale}
      onChange={setLocale}
      options={[
        { value: "fr", label: "Français", content: "FR" },
        { value: "en", label: "English", content: "EN" },
      ]}
    />
  );
}
